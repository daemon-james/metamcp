import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transports: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    handleRequest: ReturnType<typeof vi.fn>;
  }>,
  getServer: vi.fn(),
  cleanupPoolSession: vi.fn(),
  beginPoolRequest: vi.fn(),
  endPoolRequest: vi.fn(),
  buildAdminToolsOptions: vi.fn(),
  extractClientHeaders: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    close = vi.fn().mockResolvedValue(undefined);
    handleRequest = vi.fn().mockResolvedValue(undefined);

    constructor() {
      mocks.transports.push(this);
    }
  },
}));

vi.mock("@/middleware/api-key-oauth.middleware", () => ({
  authenticateApiKey: vi.fn(),
}));

vi.mock("@/middleware/lookup-endpoint-middleware", () => ({
  lookupEndpoint: vi.fn(),
}));

vi.mock("@/middleware/rate-limit.middleware", () => ({
  rateLimitMiddleware: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../lib/admin-mcp/build-admin-tools-options", () => ({
  buildAdminToolsOptions: mocks.buildAdminToolsOptions,
}));

vi.mock("../../lib/config.service", () => ({
  configService: {
    getSessionLifetime: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../../lib/metamcp/header-forwarding", () => ({
  extractClientHeaders: mocks.extractClientHeaders,
}));

vi.mock("../../lib/metamcp/metamcp-server-pool", () => ({
  metaMcpServerPool: {
    getServer: mocks.getServer,
    cleanupSession: mocks.cleanupPoolSession,
    beginRequest: mocks.beginPoolRequest,
    endRequest: mocks.endPoolRequest,
    getPoolStatus: vi.fn(() => ({
      idle: 0,
      active: 0,
      activeSessionIds: [],
      idleNamespaceUuids: [],
    })),
  },
}));

import streamableHttpRouter, { sessionManager } from "./streamable-http";

type RouteHandler = (
  req: Record<string, unknown>,
  res: Record<string, unknown>,
) => Promise<void>;

function getPostHandler(): RouteHandler {
  const router = streamableHttpRouter as unknown as {
    stack: Array<{
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: Array<{ handle: RouteHandler }>;
      };
    }>;
  };
  const route = router.stack.find(
    (layer) =>
      layer.route?.path === "/:endpoint_name/mcp" && layer.route.methods.post,
  )?.route;
  if (!route) {
    throw new Error("POST /:endpoint_name/mcp handler not found");
  }
  return route.stack[route.stack.length - 1].handle;
}

function makeRequest(body: unknown): Record<string, unknown> {
  return {
    body,
    headers: {
      accept: "application/json, text/event-stream",
    },
    namespaceUuid: "namespace-1",
    endpointName: "endpoint-1",
    endpoint: {},
    authMethod: "api-key",
  };
}

function makeResponse() {
  const response = {
    statusCode: 200,
    on: vi.fn(),
    getHeaders: vi.fn(() => ({})),
    status: vi.fn((statusCode: number) => {
      response.statusCode = statusCode;
      return response;
    }),
    json: vi.fn(() => response),
    type: vi.fn(() => response),
  };
  return response;
}

describe("public Streamable HTTP session creation", () => {
  const postHandler = getPostHandler();

  beforeEach(() => {
    for (const sessionId of sessionManager.getSessionIds()) {
      sessionManager.removeSession(sessionId);
    }
    mocks.transports.length = 0;
    vi.clearAllMocks();
    mocks.buildAdminToolsOptions.mockResolvedValue({
      enabled: false,
      userId: "",
    });
    mocks.extractClientHeaders.mockReturnValue({});
    mocks.cleanupPoolSession.mockResolvedValue(undefined);
    mocks.beginPoolRequest.mockReturnValue(true);
  });

  afterAll(() => {
    sessionManager.stopCleanupTimer();
  });

  it("rejects a session-less notification before allocating a session", async () => {
    const initialSessionIds = sessionManager.getSessionIds();
    const response = makeResponse();

    await postHandler(
      makeRequest({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(sessionManager.getSessionIds()).toEqual(initialSessionIds);
    expect(mocks.getServer).not.toHaveBeenCalled();
    expect(mocks.transports).toHaveLength(0);
  });

  it("closes and removes a registered transport when connect fails", async () => {
    const connectError = new Error("connect failed");
    const connect = vi.fn().mockRejectedValue(connectError);
    mocks.getServer.mockResolvedValue({ server: { connect } });
    const response = makeResponse();

    await postHandler(
      makeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
      response,
    );

    const sessionId = mocks.getServer.mock.calls[0][0] as string;
    expect(response.statusCode).toBe(500);
    expect(connect).toHaveBeenCalledOnce();
    expect(mocks.transports).toHaveLength(1);
    expect(mocks.transports[0].close).toHaveBeenCalledOnce();
    expect(sessionManager.getSessionIds()).not.toContain(sessionId);
    expect(mocks.cleanupPoolSession).toHaveBeenCalledWith(sessionId);
  });
});
