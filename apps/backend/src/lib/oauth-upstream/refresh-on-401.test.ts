import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/repositories", () => ({
  oauthSessionsRepository: {
    findByMcpServerUuid: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../../utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("tryRefreshUpstreamTokens", () => {
  const SERVER = {
    uuid: "00000000-0000-0000-0000-0000000000aa",
    name: "test-server",
    url: "https://api.example.com/mcp",
  };

  const loadModule = async () => {
    const repos = await import("../../db/repositories");
    const mod = await import("./refresh-on-401");
    return {
      tryRefreshUpstreamTokens: mod.tryRefreshUpstreamTokens,
      findByMcpServerUuid: repos.oauthSessionsRepository
        .findByMcpServerUuid as ReturnType<typeof vi.fn>,
      upsert: repos.oauthSessionsRepository.upsert as ReturnType<typeof vi.fn>,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns refreshed and persists new tokens on upstream 200", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();

    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_old",
      },
      code_verifier: null,
    });
    upsert.mockResolvedValue({});

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      return jsonResponse(200, {
        access_token: "NEW",
        token_type: "Bearer",
        expires_in: 3600,
      });
    });

    const result = await tryRefreshUpstreamTokens(SERVER);
    expect(result.status).toBe("refreshed");
    expect(result.tokens?.access_token).toBe("NEW");
    // Refresh token preserved per RFC 6749 §6.
    expect(result.tokens?.refresh_token).toBe("RT_old");
    expect(upsert).toHaveBeenCalledWith({
      mcp_server_uuid: SERVER.uuid,
      tokens: expect.objectContaining({
        access_token: "NEW",
        refresh_token: "RT_old",
      }),
    });
  });

  it("returns no_session when no oauth_sessions row exists", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue(undefined);
    const result = await tryRefreshUpstreamTokens(SERVER);
    expect(result.status).toBe("no_session");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("returns no_refresh_token when session has tokens but no refresh_token", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: { client_id: "c1" },
      tokens: { access_token: "x", token_type: "Bearer" },
    });
    const result = await tryRefreshUpstreamTokens(SERVER);
    expect(result.status).toBe("no_refresh_token");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("collapses concurrent refresh calls into a single upstream POST (mutex)", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();

    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_rotating",
      },
      code_verifier: null,
    });
    upsert.mockResolvedValue({});

    // The upstream is intentionally slow so both refresh calls overlap.
    // It is a rotating-refresh-token provider: the FIRST call sees
    // RT_rotating in the request and returns a new RT; the SECOND call
    // would normally see RT_rotating (stale) and 400 invalid_grant.
    // With the mutex, only ONE upstream POST happens, both callers share
    // its result.
    let postCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      postCount += 1;
      // 50ms delay so concurrent callers overlap deterministically.
      await new Promise((r) => setTimeout(r, 50));
      return jsonResponse(200, {
        access_token: "AT_new",
        token_type: "Bearer",
        refresh_token: "RT_rotated",
      });
    });

    const [a, b] = await Promise.all([
      tryRefreshUpstreamTokens(SERVER),
      tryRefreshUpstreamTokens(SERVER),
    ]);

    expect(a.status).toBe("refreshed");
    expect(b.status).toBe("refreshed");
    // Both callers observed the SAME tokens — they shared the in-flight
    // promise, so the upstream was hit exactly once.
    expect(a.tokens?.access_token).toBe("AT_new");
    expect(b.tokens?.access_token).toBe("AT_new");
    expect(postCount).toBe(1);
    // And we upsert exactly once.
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("allows a second refresh after the first completes (mutex releases)", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();

    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_one",
      },
      code_verifier: null,
    });
    upsert.mockResolvedValue({});

    let postCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      postCount += 1;
      return jsonResponse(200, {
        access_token: `AT_${postCount}`,
        token_type: "Bearer",
      });
    });

    await tryRefreshUpstreamTokens(SERVER);
    await tryRefreshUpstreamTokens(SERVER);
    expect(postCount).toBe(2);
  });

  it("releases the mutex even if the upstream throws (no permanent pinning)", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid } =
      await loadModule();

    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_one",
      },
      code_verifier: null,
    });

    let tokenPosts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      tokenPosts += 1;
      return jsonResponse(503, {
        error: "temporarily_unavailable",
      });
    });

    const first = await tryRefreshUpstreamTokens(SERVER);
    expect(first.status).toBe("failed");
    // If the mutex pinned, the second call would also resolve to first's
    // result. With the finally{} release it re-runs (and would in this
    // mock again return temporarily_unavailable — what we assert is that the
    // call *executes* a fresh attempt rather than returning the prior
    // promise). A retryable error keeps the dead-grant block out of the way,
    // which would otherwise short-circuit the second call for its own reason.
    const second = await tryRefreshUpstreamTokens(SERVER);
    expect(second.status).toBe("failed");
    // The status alone proves nothing: a pinned promise would resolve the
    // second call to the FIRST call's result, which is also "failed". Only the
    // POST count distinguishes a released mutex from a permanently pinned one.
    expect(tokenPosts).toBe(2);
  });

  it("returns failed with upstream details when upstream rejects refresh", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_revoked",
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      return jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Refresh token revoked",
      });
    });

    const result = await tryRefreshUpstreamTokens(SERVER);
    expect(result.status).toBe("needs_reauthorization");
    expect(result.error).toBe("invalid_grant");
    expect(result.upstreamStatus).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });
  it("still reports a retryable upstream error as failed", async () => {
    const { tryRefreshUpstreamTokens, findByMcpServerUuid, upsert } =
      await loadModule();
    findByMcpServerUuid.mockResolvedValue({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: "RT_transient",
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      if (urlStr.includes("/.well-known/"))
        return new Response("nope", { status: 404 });
      return jsonResponse(503, { error: "temporarily_unavailable" });
    });

    const result = await tryRefreshUpstreamTokens(SERVER);
    expect(result.status).toBe("failed");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("stops the sweep re-POSTing a grant already rejected as final", async () => {
    // The actual defect: Stripe answered invalid_grant once per 60s sweep for
    // days because an expired token always satisfies shouldRefresh.
    const repos = await import("../../db/repositories");
    const mod = await import("./refresh-on-401");
    const findByMcpServerUuid = repos.oauthSessionsRepository
      .findByMcpServerUuid as ReturnType<typeof vi.fn>;

    const expiredSession = (refreshToken: string) => ({
      mcp_server_uuid: SERVER.uuid,
      client_information: {
        client_id: "c1",
        token_endpoint: "https://upstream/token",
      },
      tokens: {
        access_token: "OLD",
        token_type: "Bearer",
        refresh_token: refreshToken,
        expires_in: 3600,
      },
      tokens_issued_at: new Date(Date.now() - 7200_000),
    });

    findByMcpServerUuid.mockResolvedValue(expiredSession("RT_revoked_sweep"));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : (url as URL).toString();
        if (urlStr.includes("/.well-known/"))
          return new Response("nope", { status: 404 });
        return jsonResponse(400, { error: "invalid_grant" });
      });

    const first = await mod.refreshIfExpiring(SERVER);
    expect(first?.status).toBe("needs_reauthorization");
    const callsAfterFirst = fetchSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Two more sweeps over the same dead grant must not touch the network,
    // and must not announce a refresh they are not performing.
    const loggerMod = await import("../../utils/logger");
    const info = loggerMod.default.info as ReturnType<typeof vi.fn>;
    info.mockClear();
    await mod.refreshIfExpiring(SERVER);
    await mod.refreshIfExpiring(SERVER);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
    expect(
      info.mock.calls.filter((c) =>
        String(c[0]).includes("refreshing ahead of expiry"),
      ),
    ).toHaveLength(0);

    // Re-authorization stores a different refresh_token, which lifts the block.
    findByMcpServerUuid.mockResolvedValue(expiredSession("RT_after_reauth"));
    await mod.refreshIfExpiring(SERVER);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
