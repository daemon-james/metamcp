import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerParameters } from "@repo/zod-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientClose: vi.fn(),
  configTimeout: vi.fn(),
  findOAuthSession: vi.fn(),
  getServerMaxAttempts: vi.fn(),
  isServerInErrorState: vi.fn(),
  recordConnectionFailure: vi.fn(),
  resetServerErrorState: vi.fn(),
  sdkConnect: vi.fn(),
  transportOptions: vi.fn(),
  transportClose: vi.fn(),
  transportStart: vi.fn(),
  upsertOAuthSession: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect(transport: Transport) {
      return mocks.sdkConnect(transport);
    }

    close() {
      return mocks.clientClose();
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    constructor(_url: URL, options?: unknown) {
      mocks.transportOptions(options);
    }

    close() {
      return mocks.transportClose();
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(_url: URL, options?: unknown) {
      mocks.transportOptions(options);
    }
  },
}));

vi.mock("../stdio-transport/process-managed-transport", () => ({
  ProcessManagedStdioTransport: class {
    close() {
      return mocks.transportClose();
    }

    start() {
      return mocks.transportStart();
    }
  },
}));

vi.mock("../../db/repositories", () => ({
  oauthSessionsRepository: {
    findByMcpServerUuid: mocks.findOAuthSession,
    upsert: mocks.upsertOAuthSession,
  },
}));

vi.mock("../config.service", () => ({
  configService: { getMcpTimeout: mocks.configTimeout },
}));

vi.mock("../../utils/logger", () => ({
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("./log-store", () => ({
  metamcpLogStore: { addLog: vi.fn() },
}));

vi.mock("./server-error-tracker", () => ({
  serverErrorTracker: {
    getServerMaxAttempts: mocks.getServerMaxAttempts,
    isServerInErrorState: mocks.isServerInErrorState,
    recordConnectionFailure: mocks.recordConnectionFailure,
    resetServerErrorState: mocks.resetServerErrorState,
  },
}));

vi.mock("./utils", () => ({
  resolveEnvVariables: vi.fn((env: Record<string, string>) => env),
}));

import {
  clearCurrentAccessTokens,
  getCurrentAccessToken,
  setCurrentAccessToken,
} from "../oauth-upstream/access-token-store";
import { isUpstreamUnauthorizedError } from "../oauth-upstream/token-exchange";
import {
  connectClientWithDeadline,
  connectMetaMcpClient,
  createMetaMcpClient,
  recoverRejectedAccessToken,
} from "./client";
import {
  ConnectionTimeoutError,
  isTerminalConnectionError,
} from "./connection-errors";

const SERVER: ServerParameters = {
  uuid: "00000000-0000-0000-0000-0000000000bb",
  name: "oauth-server",
  description: "",
  type: "SSE",
  stderr: "ignore",
  url: "https://mcp.example.com/sse",
  created_at: "2026-08-23T00:00:00.000Z",
  status: "ACTIVE",
  oauth_tokens: {
    access_token: "OLD",
    token_type: "Bearer",
    refresh_token: "RT_old",
  },
};

const STDIO_SERVER: ServerParameters = {
  uuid: "00000000-0000-0000-0000-0000000000cc",
  name: "missing-command",
  description: "",
  type: "STDIO",
  stderr: "ignore",
  command: "/nonexistent/binary",
  created_at: "2026-08-23T00:00:00.000Z",
  status: "ACTIVE",
};

describe("connectClientWithDeadline", () => {
  it("closes a transport whose start never settles", async () => {
    const transportClose = vi.fn().mockResolvedValue(undefined);
    const transport = {
      close: transportClose,
      start: vi.fn(() => new Promise<void>(() => undefined)),
    } as unknown as Transport;
    const clientClose = vi.fn().mockResolvedValue(undefined);
    const client = {
      close: clientClose,
      connect: vi.fn(async (candidate: Transport) => {
        await candidate.start?.();
      }),
    } as unknown as Client;

    const startedAt = Date.now();
    const error = await connectClientWithDeadline(client, transport, 20).catch(
      (caught: unknown) => caught,
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(error).toBeInstanceOf(ConnectionTimeoutError);
    expect(isTerminalConnectionError(error)).toBe(false);
    expect(isUpstreamUnauthorizedError(error)).toBe(false);
    expect(transportClose).toHaveBeenCalledOnce();
    expect(clientClose).toHaveBeenCalledOnce();
  });
});

describe("connectMetaMcpClient refresh retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientClose.mockResolvedValue(undefined);
    mocks.configTimeout.mockResolvedValue(100);
    mocks.getServerMaxAttempts.mockResolvedValue(1);
    mocks.isServerInErrorState.mockResolvedValue(false);
    mocks.recordConnectionFailure.mockResolvedValue(undefined);
    mocks.resetServerErrorState.mockResolvedValue(undefined);
    mocks.sdkConnect.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { code: 401 }),
    );
    mocks.transportClose.mockResolvedValue(undefined);
    mocks.upsertOAuthSession.mockResolvedValue({});
    mocks.findOAuthSession.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "client-1",
        token_endpoint: "https://auth.example.com/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_old",
      },
    });
  });

  it("refreshes once when every new access token is rejected", async () => {
    let tokenPosts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (init?.method === "POST") {
        expect(String(url)).toBe("https://auth.example.com/token");
        tokenPosts += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: `NEW_${tokenPosts}`,
              token_type: "Bearer",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    const result = await connectMetaMcpClient({ ...SERVER });

    expect(result).toBeUndefined();
    expect(tokenPosts).toBe(1);
    expect(mocks.sdkConnect).toHaveBeenCalledTimes(2);
    expect(mocks.recordConnectionFailure).toHaveBeenCalledWith(
      SERVER.uuid,
      "upstream rejected the credentials; re-authorisation required",
      true,
    );
  });
});

describe("createMetaMcpClient authentication", () => {
  type TransportOptions = {
    requestInit?: { headers?: Record<string, string> };
    fetch?: unknown;
    eventSourceInit?: { fetch?: unknown };
  };
  const lastTransportOptions = () =>
    mocks.transportOptions.mock.lastCall?.[0] as TransportOptions | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["SSE", "STREAMABLE_HTTP"] as const)(
    "keeps a static bearer token in the %s request headers",
    (type) => {
      createMetaMcpClient({
        ...SERVER,
        type,
        oauth_tokens: null,
        bearerToken: "STATIC",
        headers: { "X-Api-Key": "k" },
      });

      const options = lastTransportOptions();
      expect(options?.requestInit?.headers).toEqual({
        "X-Api-Key": "k",
        Authorization: "Bearer STATIC",
      });
      expect(options?.fetch).toBeUndefined();
    },
  );

  it.each(["SSE", "STREAMABLE_HTTP"] as const)(
    "adds the OAuth token per request on %s instead of fixing it at creation",
    (type) => {
      createMetaMcpClient({
        ...SERVER,
        type,
        bearerToken: "STATIC",
        headers: { "X-Api-Key": "k" },
      });

      const options = lastTransportOptions();
      expect(options?.requestInit?.headers).toEqual({ "X-Api-Key": "k" });
      expect(options?.fetch).toEqual(expect.any(Function));
      if (type === "SSE") {
        expect(options?.eventSourceInit?.fetch).toEqual(expect.any(Function));
      }
    },
  );
});

describe("recoverRejectedAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCurrentAccessTokens();
    mocks.configTimeout.mockResolvedValue(1000);
    mocks.upsertOAuthSession.mockResolvedValue({});
    mocks.findOAuthSession.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "client-1",
        token_endpoint: "https://auth.example.com/token",
      },
      tokens: {
        access_token: "A",
        token_type: "Bearer",
        refresh_token: "RT",
      },
    });
  });

  it("uses a token another path already refreshed to, without a refresh", async () => {
    setCurrentAccessToken(SERVER.uuid, "B");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(recoverRejectedAccessToken(SERVER, "A")).resolves.toBe("B");
    expect(mocks.findOAuthSession).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("adopts a newer token found in the database", async () => {
    setCurrentAccessToken(SERVER.uuid, "A");
    mocks.findOAuthSession.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      tokens: { access_token: "C", token_type: "Bearer" },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(recoverRejectedAccessToken(SERVER, "A")).resolves.toBe("C");
    expect(getCurrentAccessToken(SERVER.uuid)).toBe("C");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes when the rejected token is still the newest, and shares that refresh", async () => {
    let tokenPosts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (init?.method === "POST") {
        tokenPosts += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: "B", token_type: "Bearer" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    const results = await Promise.all([
      recoverRejectedAccessToken(SERVER, "A"),
      recoverRejectedAccessToken(SERVER, "A"),
    ]);

    expect(results).toEqual(["B", "B"]);
    expect(tokenPosts).toBe(1);
    expect(getCurrentAccessToken(SERVER.uuid)).toBe("B");
    // A request rejected with the old token after the refresh finished must
    // not spend the rotated refresh token again.
    await expect(recoverRejectedAccessToken(SERVER, "A")).resolves.toBe("B");
    expect(tokenPosts).toBe(1);
  });

  it("gives up when there is no refresh token", async () => {
    mocks.findOAuthSession.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      tokens: { access_token: "A", token_type: "Bearer" },
    });

    await expect(
      recoverRejectedAccessToken(SERVER, "A"),
    ).resolves.toBeUndefined();
  });
});

describe("connectMetaMcpClient terminal stdio spawn failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientClose.mockResolvedValue(undefined);
    mocks.configTimeout.mockResolvedValue(100);
    mocks.getServerMaxAttempts.mockResolvedValue(4);
    mocks.isServerInErrorState.mockResolvedValue(false);
    mocks.recordConnectionFailure.mockResolvedValue(undefined);
    mocks.transportClose.mockResolvedValue(undefined);
    mocks.sdkConnect.mockImplementation(async (transport: Transport) => {
      await transport.start?.();
    });
  });

  it("rejects an ENOENT spawn error on the first attempt without backoff", async () => {
    const realNow = Date.now;
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const spawnError = Object.assign(
      new Error("spawn /nonexistent/binary ENOENT"),
      { code: "ENOENT", syscall: "spawn /nonexistent/binary" },
    );
    mocks.transportStart.mockRejectedValue(spawnError);
    const startedAt = realNow();

    try {
      const connection = connectMetaMcpClient({ ...STDIO_SERVER });
      const rejection = expect(connection).rejects.toBe(spawnError);
      await vi.advanceTimersByTimeAsync(5000);

      expect(mocks.transportStart).toHaveBeenCalledOnce();
      expect(setTimeoutSpy).not.toHaveBeenCalledWith(
        expect.any(Function),
        5000,
      );
      await rejection;
      expect(realNow() - startedAt).toBeLessThan(500);
      expect(mocks.recordConnectionFailure).toHaveBeenCalledWith(
        STDIO_SERVER.uuid,
        spawnError.message,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
