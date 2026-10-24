import { ServerParameters } from "@repo/zod-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectedClient } from "./client";

const { connectMetaMcpClient } = vi.hoisted(() => ({
  connectMetaMcpClient: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../db/repositories", () => ({
  mcpServersRepository: {
    findOAuthCapableServers: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../config.service", () => ({
  configService: {
    getSessionLifetime: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../oauth-upstream/refresh-on-401", () => ({
  refreshIfExpiring: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./client", () => ({ connectMetaMcpClient }));

vi.mock("./live-reload/live-reload", () => ({
  watchConnectionTools: vi.fn(),
}));

vi.mock("./log-store", () => ({
  metamcpLogStore: { addLog: vi.fn() },
}));

vi.mock("./server-error-tracker", () => ({
  serverErrorTracker: {
    isServerInErrorState: vi.fn().mockResolvedValue(false),
    recordServerCrash: vi.fn().mockResolvedValue(undefined),
    resetServerErrorState: vi.fn().mockResolvedValue(undefined),
  },
}));

import { McpServerPool } from "./mcp-server-pool";

const pool = McpServerPool.getInstance();

function makeClient(label: string): ConnectedClient {
  return {
    client: { ping: vi.fn() },
    cleanup: vi.fn().mockResolvedValue(undefined),
    label,
  } as unknown as ConnectedClient;
}

function makeServer(
  uuid: string,
  options: { forwardedValue?: string } = {},
): ServerParameters {
  return {
    uuid,
    name: uuid,
    description: "",
    type: "STREAMABLE_HTTP",
    created_at: new Date().toISOString(),
    status: "active",
    stderr: "inherit",
    url: "http://example.com/mcp",
    headers:
      options.forwardedValue === undefined
        ? {}
        : { "X-Caller": options.forwardedValue },
    forward_headers:
      options.forwardedValue === undefined ? {} : { "X-Caller": "X-Caller" },
  };
}

function setCaps(perServer: number, total: number): void {
  Reflect.set(pool, "maxConnectionsPerServer", perServer);
  Reflect.set(pool, "maxTotalConnections", total);
}

describe("McpServerPool connection caps", () => {
  beforeEach(async () => {
    await pool.cleanupAll();
    connectMetaMcpClient.mockReset();
    setCaps(2, 100);
  });

  afterEach(async () => {
    await pool.cleanupAll();
  });

  it("gives forwarded headers separate clients past the per-server cap", async () => {
    let clientNumber = 0;
    connectMetaMcpClient.mockImplementation(async () => {
      clientNumber += 1;
      return makeClient(`forwarded-${clientNumber}`);
    });

    const sessions = await Promise.all(
      ["caller-a", "caller-b", "caller-c", "caller-d"].map(
        (forwardedValue, index) =>
          pool.getSession(
            `forwarded-${index}`,
            "forwarded-server",
            makeServer("forwarded-server", { forwardedValue }),
          ),
      ),
    );

    expect(sessions.every((session) => session !== undefined)).toBe(true);
    expect(new Set(sessions).size).toBe(4);
    expect(connectMetaMcpClient).toHaveBeenCalledTimes(4);

    await pool.cleanupAll();
    connectMetaMcpClient.mockClear();

    const sameCredentialParams = makeServer("forwarded-server", {
      forwardedValue: "same-caller",
    });
    const [sameCredentialFirst, sameCredentialSecond] = await Promise.all([
      pool.getSession("same-1", "forwarded-server", sameCredentialParams),
      pool.getSession("same-2", "forwarded-server", sameCredentialParams),
    ]);

    expect(sameCredentialFirst).toBeDefined();
    expect(sameCredentialSecond).toBeDefined();
    expect(sameCredentialFirst).not.toBe(sameCredentialSecond);
    expect(connectMetaMcpClient).toHaveBeenCalledTimes(2);
    const serverParamsCache = Reflect.get(pool, "serverParamsCache") as Record<
      string,
      ServerParameters
    >;
    expect(Object.hasOwn(serverParamsCache, "forwarded-server")).toBe(false);
  });

  it("shares ordinary connections at the per-server cap", async () => {
    connectMetaMcpClient.mockImplementation(async () => makeClient("ordinary"));

    const ordinaryParams = makeServer("ordinary-server");
    const ordinaryFirst = await pool.getSession(
      "ordinary-1",
      "ordinary-server",
      ordinaryParams,
    );
    await vi.waitFor(() => {
      expect(connectMetaMcpClient).toHaveBeenCalledTimes(2);
    });
    const ordinarySecond = await pool.getSession(
      "ordinary-2",
      "ordinary-server",
      ordinaryParams,
    );
    const ordinaryThird = await pool.getSession(
      "ordinary-3",
      "ordinary-server",
      ordinaryParams,
    );

    expect(ordinaryFirst).toBeDefined();
    expect(ordinarySecond).toBeDefined();
    expect([ordinaryFirst, ordinarySecond]).toContain(ordinaryThird);
    expect(connectMetaMcpClient).toHaveBeenCalledTimes(2);
  });

  it("limits ten concurrent sessions for one server to two connector calls", async () => {
    let clientNumber = 0;
    connectMetaMcpClient.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      clientNumber += 1;
      return makeClient(`client-${clientNumber}`);
    });

    const params = makeServer("shared-server");
    const sessions = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        pool.getSession(`session-${index}`, "shared-server", params),
      ),
    );

    expect(connectMetaMcpClient.mock.calls.length).toBeLessThanOrEqual(2);
    expect(sessions.every((session) => session !== undefined)).toBe(true);
  });

  it("counts active attempts against the global connection cap", async () => {
    setCaps(10, 2);
    connectMetaMcpClient.mockImplementation(
      async (params: ServerParameters) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return makeClient(params.uuid);
      },
    );

    await Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const serverUuid = `server-${index}`;
        return pool.getSession(
          `session-${index}`,
          serverUuid,
          makeServer(serverUuid),
        );
      }),
    );

    expect(connectMetaMcpClient.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("releases a reservation after a failed dial", async () => {
    setCaps(1, 1);
    const params = makeServer("forwarded-server", {
      forwardedValue: "caller-a",
    });
    connectMetaMcpClient
      .mockRejectedValueOnce(new Error("dial failed"))
      .mockResolvedValueOnce(makeClient("replacement"));

    await expect(
      pool.getSession("failed", "forwarded-server", params),
    ).rejects.toThrow("dial failed");

    await expect(
      pool.getSession("replacement", "forwarded-server", params),
    ).resolves.toBeDefined();
    expect(connectMetaMcpClient).toHaveBeenCalledTimes(2);
  });
});

describe("McpServerPool closed connections", () => {
  beforeEach(async () => {
    await pool.cleanupAll();
    connectMetaMcpClient.mockReset();
    setCaps(2, 100);
  });

  afterEach(async () => {
    await pool.cleanupAll();
  });

  it("forgets a connection whose backend exited, so the next use reconnects", async () => {
    // A deploy SIGINTs the old process, which exits 0: no crash is reported.
    let clientNumber = 0;
    connectMetaMcpClient.mockImplementation(async () => {
      clientNumber += 1;
      return makeClient(`exited-${clientNumber}`);
    });
    const server = makeServer("exits-cleanly");

    const first = await pool.getSession("session-1", server.uuid, server);
    expect(first).toBeDefined();
    (first as ConnectedClient).client.onclose?.();

    const second = await pool.getSession("session-1", server.uuid, server);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });
});
