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
  attachReloader: vi.fn(),
  detachReloader: vi.fn(),
  streamOpened: vi.fn(),
  streamClosed: vi.fn(),
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

vi.mock("../../lib/metamcp/live-reload/live-reload", () => ({
  toolListReloader: {
    attach: mocks.attachReloader,
    detach: mocks.detachReloader,
    streamOpened: mocks.streamOpened,
    streamClosed: mocks.streamClosed,
  },
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

function getHandler(method: "get" | "post"): RouteHandler {
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
      layer.route?.path === "/:endpoint_name/mcp" &&
      layer.route.methods[method],
  )?.route;
  if (!route) {
    throw new Error(`${method} /:endpoint_name/mcp handler not found`);
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

// Production shape. index.ts skips express.json() for /metamcp/, so `body` is
// undefined and the payload only exists on the request stream. Every test that
// sets `body` directly is testing a request the server never receives, which is
// how a guard that rejected EVERY session-less POST shipped green.
function makeStreamRequest(payload: unknown): Record<string, unknown> {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    body: undefined,
    headers: {
      accept: "application/json, text/event-stream",
    },
    namespaceUuid: "namespace-1",
    endpointName: "endpoint-1",
    endpoint: {},
    authMethod: "api-key",
    async *[Symbol.asyncIterator]() {
      yield raw;
    },
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
  const postHandler = getHandler("post");

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

  it("accepts a stream-delivered initialize request (body undefined)", async () => {
    // The regression: isInitializeRequest(req.body) was tested against a value
    // these routes never populate, so a real initialize was answered 400 and no
    // client could open a session. The rig showed 8 of 8 sessions with 0 tools.
    const connect = vi.fn().mockResolvedValue(undefined);
    mocks.getServer.mockResolvedValue({ server: { connect } });
    const response = makeResponse();

    await postHandler(
      makeStreamRequest({
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

    expect(response.statusCode).not.toBe(400);
    expect(mocks.getServer).toHaveBeenCalledOnce();
    expect(mocks.transports).toHaveLength(1);
  });

  it("still rejects a stream-delivered notification", async () => {
    const initialSessionIds = sessionManager.getSessionIds();
    const response = makeResponse();

    await postHandler(
      makeStreamRequest({
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

  it("hands a new session to the tool-list reloader, which cannot end it", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    mocks.getServer.mockResolvedValue({ server: { connect } });

    await postHandler(
      makeStreamRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
      makeResponse(),
    );

    const sessionId = mocks.getServer.mock.calls[0][0] as string;
    expect(mocks.attachReloader).toHaveBeenCalledOnce();
    const args = mocks.attachReloader.mock.calls[0];
    expect(args).toHaveLength(3);
    const [attachedId, namespaceUuid, transport] = args;
    expect(attachedId).toBe(sessionId);
    expect(namespaceUuid).toBe("namespace-1");
    expect(transport).toBe(mocks.transports[0]);
    expect(sessionManager.getSessionIds()).toContain(sessionId);
  });

  it("marks the session's stream open for exactly as long as its GET lasts", async () => {
    let finishStream: () => void = () => {};
    const transport = {
      close: vi.fn(),
      handleRequest: vi.fn(
        () => new Promise<void>((resolve) => (finishStream = resolve)),
      ),
    };
    sessionManager.addSession("s-get", transport as never);
    const pending = getHandler("get")(
      { headers: { "mcp-session-id": "s-get", accept: "text/event-stream" } },
      makeResponse(),
    );

    await vi.waitFor(() => expect(transport.handleRequest).toHaveBeenCalled());
    expect(mocks.streamOpened).toHaveBeenCalledWith("s-get");
    expect(mocks.streamClosed).not.toHaveBeenCalled();

    finishStream();
    await pending;
    expect(mocks.streamClosed).toHaveBeenCalledWith("s-get");
  });
});
