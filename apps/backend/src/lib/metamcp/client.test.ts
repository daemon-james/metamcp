import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerParameters } from "@repo/zod-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientClose: vi.fn(),
  configTimeout: vi.fn(),
  findOAuthSession: vi.fn(),
  isServerInErrorState: vi.fn(),
  recordConnectionFailure: vi.fn(),
  resetServerErrorState: vi.fn(),
  sdkConnect: vi.fn(),
  transportClose: vi.fn(),
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
    close() {
      return mocks.transportClose();
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));

vi.mock("../stdio-transport/process-managed-transport", () => ({
  ProcessManagedStdioTransport: class {},
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
    getServerMaxAttempts: vi.fn().mockResolvedValue(1),
    isServerInErrorState: mocks.isServerInErrorState,
    recordConnectionFailure: mocks.recordConnectionFailure,
    resetServerErrorState: mocks.resetServerErrorState,
  },
}));

vi.mock("./utils", () => ({
  resolveEnvVariables: vi.fn((env: Record<string, string>) => env),
}));

import { isUpstreamUnauthorizedError } from "../oauth-upstream/token-exchange";
import { connectClientWithDeadline, connectMetaMcpClient } from "./client";
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
