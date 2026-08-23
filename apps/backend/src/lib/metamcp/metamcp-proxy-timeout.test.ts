import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectedClient } from "./client";

const mocks = vi.hoisted(() => {
  const passThrough = () => (handler: unknown) => handler;

  return {
    configService: {
      getMcpResetTimeoutOnProgress: vi.fn(),
      getMcpTimeout: vi.fn(),
      getMcpMaxTotalTimeout: vi.fn(),
    },
    getMcpServers: vi.fn(),
    logger: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    namespacesRepository: {
      findByUuid: vi.fn(),
    },
    pool: {
      cleanupSession: vi.fn(),
      ensureIdleSessions: vi.fn(),
      getPoolStatus: vi.fn(),
      getSession: vi.fn(),
      invalidateServerConnection: vi.fn(),
      resetServerErrorState: vi.fn(),
    },
    passThrough,
    toolsImplementations: {
      sync: vi.fn(),
    },
    toolsSyncCache: {
      hasChanged: vi.fn(),
      update: vi.fn(),
    },
  };
});

vi.mock("@/utils/logger", () => ({ default: mocks.logger }));
vi.mock("../../db/repositories/namespaces.repo", () => ({
  namespacesRepository: mocks.namespacesRepository,
}));
vi.mock("../../trpc/tools.impl", () => ({
  toolsImplementations: mocks.toolsImplementations,
}));
vi.mock("../admin-mcp/admin-session-context", () => ({
  getAdminToolsContext: vi.fn(),
}));
vi.mock("../admin-mcp/tools-registry", () => ({
  executeAdminTool: vi.fn(),
  getAdminToolsForMcp: vi.fn(() => []),
  isExposedAdminToolName: vi.fn(() => false),
}));
vi.mock("../config.service", () => ({
  configService: mocks.configService,
}));
vi.mock("./fetch-metamcp", () => ({
  getMcpServers: mocks.getMcpServers,
}));
vi.mock("./mcp-server-pool", () => ({
  mcpServerPool: mocks.pool,
}));
vi.mock("./metamcp-middleware/audit-requests.functional", () => ({
  createAuditCallToolMiddleware: mocks.passThrough,
}));
vi.mock("./metamcp-middleware/filter-tools.functional", () => ({
  createFilterCallToolMiddleware: mocks.passThrough,
  createFilterListToolsMiddleware: mocks.passThrough,
}));
vi.mock("./metamcp-middleware/tool-identity", () => ({
  resolveToolIdentity: vi.fn(),
}));
vi.mock("./metamcp-middleware/tool-overrides.functional", () => ({
  createToolOverridesCallToolMiddleware: mocks.passThrough,
  createToolOverridesListToolsMiddleware: mocks.passThrough,
  mapOverrideNameToOriginal: vi.fn((name: string) => name),
}));
vi.mock("./tools-sync-cache", () => ({
  toolsSyncCache: mocks.toolsSyncCache,
}));
vi.mock("./utils", () => ({
  sanitizeName: (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_"),
}));

import { createServer } from "./metamcp-proxy";

type RequestFn = (
  request: { method: string; params?: { cursor?: string } },
  schema: unknown,
  options?: RequestOptions,
) => Promise<unknown>;

type RegisteredHandler = (
  request: { method: string; params?: Record<string, unknown> },
  extra: Record<string, unknown>,
) => Promise<unknown>;

function makeSession(
  name: string,
  request: RequestFn,
  capabilities: Record<string, unknown> = { tools: {} },
): ConnectedClient {
  return {
    client: {
      getServerCapabilities: () => capabilities,
      getServerVersion: () => ({ name, version: "1.0.0" }),
      request,
    },
  } as unknown as ConnectedClient;
}

function getHandler(server: Server, method: string): RegisteredHandler {
  const handlers = (
    server as unknown as {
      _requestHandlers: Map<string, RegisteredHandler>;
    }
  )._requestHandlers;
  const handler = handlers.get(method);
  if (!handler) {
    throw new Error(`No handler registered for ${method}`);
  }
  return handler;
}

function requestTimeoutError(): Error & { code: number } {
  return Object.assign(new Error("MCP error -32001: Request timed out"), {
    code: -32001,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configService.getMcpResetTimeoutOnProgress.mockResolvedValue(true);
  mocks.configService.getMcpTimeout.mockResolvedValue(40);
  mocks.configService.getMcpMaxTotalTimeout.mockResolvedValue(40);
  mocks.namespacesRepository.findByUuid.mockResolvedValue(undefined);
  mocks.pool.cleanupSession.mockResolvedValue(undefined);
  mocks.pool.ensureIdleSessions.mockResolvedValue(undefined);
  mocks.pool.getPoolStatus.mockReturnValue({ idle: 1, active: 0 });
  mocks.pool.invalidateServerConnection.mockResolvedValue(undefined);
  mocks.pool.resetServerErrorState.mockResolvedValue(undefined);
  mocks.toolsImplementations.sync.mockResolvedValue(undefined);
  mocks.toolsSyncCache.hasChanged.mockReturnValue(false);
});

describe("MetaMCP proxy request timeouts", () => {
  it("returns healthy tools when one backend never answers tools/list", async () => {
    const healthyARequest = vi.fn<RequestFn>().mockResolvedValue({
      tools: [{ name: "first", description: "first tool" }],
    });
    const healthyBRequest = vi.fn<RequestFn>().mockResolvedValue({
      tools: [{ name: "second", description: "second tool" }],
    });
    const never = new Promise<never>(() => {});
    const hungRequest = vi.fn<RequestFn>((_request, _schema, options) => {
      const timeout = options?.timeout ?? 10_000;
      const sdkTimeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(requestTimeoutError()), timeout);
      });
      return Promise.race([never, sdkTimeout]);
    });

    const sessions = new Map<string, ConnectedClient>([
      ["server-a", makeSession("alpha", healthyARequest)],
      ["server-b", makeSession("beta", healthyBRequest)],
      ["server-hung", makeSession("hung", hungRequest)],
    ]);
    mocks.getMcpServers.mockResolvedValue({
      "server-a": { name: "alpha" },
      "server-b": { name: "beta" },
      "server-hung": { name: "hung" },
    });
    mocks.pool.getSession.mockImplementation(
      async (_sessionId: string, serverUuid: string) =>
        sessions.get(serverUuid),
    );

    const { server } = await createServer("namespace", "session");
    const listTools = getHandler(server, "tools/list");
    const startedAt = performance.now();
    const result = (await listTools(
      { method: "tools/list", params: {} },
      {},
    )) as { tools: Array<{ name: string }> };
    const elapsed = performance.now() - startedAt;

    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "alpha__first",
      "beta__second",
    ]);
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(500);
    expect(hungRequest).toHaveBeenCalled();
    expect(hungRequest.mock.calls[0]?.[2]).toMatchObject({
      timeout: expect.any(Number),
      maxTotalTimeout: expect.any(Number),
    });
    expect(
      mocks.logger.error.mock.calls.some(
        ([message]) =>
          typeof message === "string" &&
          message.includes("tools/list DEGRADED") &&
          message.includes("hung"),
      ),
    ).toBe(true);
  }, 1_000);

  it("uses one total timeout budget across all tools/list pages", async () => {
    mocks.configService.getMcpTimeout.mockResolvedValue(200);
    mocks.configService.getMcpMaxTotalTimeout.mockResolvedValue(200);

    const request = vi.fn<RequestFn>(async (message) => {
      if (!message.params?.cursor) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { tools: [{ name: "first" }], nextCursor: "next" };
      }
      return { tools: [{ name: "second" }] };
    });
    const session = makeSession("paged", request);
    mocks.getMcpServers.mockResolvedValue({
      "paged-server": { name: "paged" },
    });
    mocks.pool.getSession.mockResolvedValue(session);

    const { server } = await createServer("namespace", "session");
    const listTools = getHandler(server, "tools/list");
    const result = (await listTools(
      { method: "tools/list", params: {} },
      {},
    )) as { tools: Array<{ name: string }> };

    expect(result.tools).toHaveLength(2);
    const firstOptions = request.mock.calls[0]?.[2];
    const secondOptions = request.mock.calls[1]?.[2];
    expect(firstOptions?.timeout).toBeGreaterThan(180);
    expect(secondOptions?.timeout).toBeLessThan(
      (firstOptions?.timeout as number) - 20,
    );
  });

  it("passes configured timeouts to the other list methods", async () => {
    const request = vi.fn<RequestFn>(async (message) => {
      if (message.method === "prompts/list") {
        return { prompts: [] };
      }
      if (message.method === "resources/templates/list") {
        return { resourceTemplates: [] };
      }
      return { resources: [] };
    });
    const session = makeSession("catalog", request, {
      prompts: {},
      resources: {},
    });
    mocks.getMcpServers.mockResolvedValue({
      "catalog-server": { name: "catalog" },
    });
    mocks.pool.getSession.mockResolvedValue(session);

    const { server } = await createServer("namespace", "session");
    await getHandler(server, "prompts/list")(
      { method: "prompts/list", params: {} },
      {},
    );
    await getHandler(server, "resources/list")(
      { method: "resources/list", params: {} },
      {},
    );
    await getHandler(server, "resources/templates/list")(
      { method: "resources/templates/list", params: {} },
      {},
    );

    for (const method of [
      "prompts/list",
      "resources/list",
      "resources/templates/list",
    ]) {
      const call = request.mock.calls.find(
        ([message]) => message.method === method,
      );
      expect(call?.[2]).toMatchObject({
        timeout: 40,
        maxTotalTimeout: 40,
        resetTimeoutOnProgress: true,
      });
    }
  });

  it("does not replay a tools/call request after an SDK timeout", async () => {
    const timeoutError = requestTimeoutError();
    const request = vi.fn<RequestFn>(async (message) => {
      if (message.method === "tools/list") {
        return { tools: [{ name: "send_email" }] };
      }
      throw timeoutError;
    });
    const session = makeSession("mail", request);

    mocks.getMcpServers.mockResolvedValue({
      "mail-server": { name: "mail" },
    });
    mocks.pool.getSession.mockResolvedValue(session);

    const { server } = await createServer("namespace", "session");
    const listTools = getHandler(server, "tools/list");
    await listTools({ method: "tools/list", params: {} }, {});

    const callTool = getHandler(server, "tools/call");
    await expect(
      callTool(
        {
          method: "tools/call",
          params: { name: "mail__send_email", arguments: {} },
        },
        {},
      ),
    ).rejects.toBe(timeoutError);

    const toolCalls = request.mock.calls.filter(
      ([message]) => message.method === "tools/call",
    );
    expect(toolCalls).toHaveLength(1);
    expect(mocks.pool.invalidateServerConnection).not.toHaveBeenCalled();
  });
});
