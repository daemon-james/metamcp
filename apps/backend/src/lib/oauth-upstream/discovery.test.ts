import { describe, expect, it, vi } from "vitest";

import {
  discoverProtectedResourceMetadata,
  resolveAuthorizationServer,
} from "./discovery";

type FetchImpl = typeof fetch;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const notFound = () => new Response("", { status: 404 });

/** Serves fixed bodies by URL; everything else 404s. */
const routes = (map: Record<string, unknown>) =>
  vi.fn<FetchImpl>(async (url) => {
    const href = String(url);
    return href in map ? json(200, map[href]) : notFound();
  });

const MCP = "https://mcp.example.com/api/mcp";

describe("discoverProtectedResourceMetadata", () => {
  it("finds metadata at the path-suffixed well-known URI", async () => {
    const fetchImpl = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp": {
        resource: "https://mcp.example.com/api/mcp",
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["read", "write"],
      },
    });

    const prm = await discoverProtectedResourceMetadata(MCP, { fetchImpl });
    expect(prm?.authorization_servers).toEqual(["https://auth.example.com"]);
    expect(prm?.resource).toBe("https://mcp.example.com/api/mcp");
    expect(prm?.scopes_supported).toEqual(["read", "write"]);
  });

  it("falls back to the origin-root well-known URI", async () => {
    const fetchImpl = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource": {
        authorization_servers: ["https://auth.example.com"],
      },
    });

    const prm = await discoverProtectedResourceMetadata(MCP, { fetchImpl });
    expect(prm?.authorization_servers).toEqual(["https://auth.example.com"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses the URL from a WWW-Authenticate challenge without probing", async () => {
    const fetchImpl = routes({
      "https://elsewhere.example.com/prm": {
        authorization_servers: ["https://auth.example.com"],
      },
    });

    const prm = await discoverProtectedResourceMetadata(MCP, {
      fetchImpl,
      resourceMetadataUrl: "https://elsewhere.example.com/prm",
    });
    expect(prm?.authorization_servers).toEqual(["https://auth.example.com"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns null when nothing is published", async () => {
    expect(
      await discoverProtectedResourceMetadata(MCP, { fetchImpl: routes({}) }),
    ).toBeNull();
  });

  it("ignores a non-JSON body and keeps looking", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (url) =>
      String(url).endsWith("/api/mcp")
        ? new Response("<html>", { status: 200 })
        : json(200, { authorization_servers: ["https://auth.example.com"] }),
    );

    const prm = await discoverProtectedResourceMetadata(MCP, { fetchImpl });
    expect(prm?.authorization_servers).toEqual(["https://auth.example.com"]);
  });
});

describe("resolveAuthorizationServer", () => {
  // The case the old origin-root-only discovery could never handle.
  it("resolves an authorization server on a different host", async () => {
    const fetchImpl = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp": {
        resource: "https://mcp.example.com/api/mcp",
        authorization_servers: ["https://auth.example.com"],
      },
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://auth.example.com",
        token_endpoint: "https://auth.example.com/oauth/token",
      },
    });

    const resolved = await resolveAuthorizationServer(MCP, { fetchImpl });
    expect(resolved.issuer).toBe("https://auth.example.com");
    expect(resolved.metadata?.token_endpoint).toBe(
      "https://auth.example.com/oauth/token",
    );
    expect(resolved.resource).toBe("https://mcp.example.com/api/mcp");
  });

  it("walks the ladder to the OIDC path-appending form", async () => {
    const fetchImpl = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp": {
        authorization_servers: ["https://auth.example.com/tenant1"],
      },
      "https://auth.example.com/tenant1/.well-known/openid-configuration": {
        issuer: "https://auth.example.com/tenant1",
        token_endpoint: "https://auth.example.com/tenant1/token",
      },
    });

    const resolved = await resolveAuthorizationServer(MCP, { fetchImpl });
    expect(resolved.metadata?.token_endpoint).toBe(
      "https://auth.example.com/tenant1/token",
    );
  });

  // Security requirement: a resource server must not be able to point us at an
  // issuer whose metadata then claims a different identity.
  it("discards metadata whose issuer does not match, and does not fall back to it", async () => {
    const fetchImpl = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp": {
        authorization_servers: ["https://auth.example.com"],
      },
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://evil.example.com",
        token_endpoint: "https://evil.example.com/token",
      },
    });

    const resolved = await resolveAuthorizationServer(MCP, { fetchImpl });
    expect(resolved.metadata).toBeNull();
    expect(resolved.issuer).toBeNull();
  });

  it("tries the next issuer when the first yields nothing", async () => {
    const fetchImpl = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp": {
        authorization_servers: [
          "https://dead.example.com",
          "https://auth.example.com",
        ],
      },
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://auth.example.com",
        token_endpoint: "https://auth.example.com/oauth/token",
      },
    });

    const resolved = await resolveAuthorizationServer(MCP, { fetchImpl });
    expect(resolved.issuer).toBe("https://auth.example.com");
  });

  // Self-contained servers that host their own endpoints must keep working.
  it("falls back to the MCP server's own origin when no PRM is published", async () => {
    const fetchImpl = routes({
      "https://mcp.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://mcp.example.com",
        token_endpoint: "https://mcp.example.com/oauth/token",
      },
    });

    const resolved = await resolveAuthorizationServer(MCP, { fetchImpl });
    expect(resolved.metadata?.token_endpoint).toBe(
      "https://mcp.example.com/oauth/token",
    );
  });

  it("returns nulls rather than throwing when nothing resolves", async () => {
    const resolved = await resolveAuthorizationServer(MCP, {
      fetchImpl: routes({}),
    });
    expect(resolved).toEqual({
      metadata: null,
      issuer: null,
      resource: null,
      scopesSupported: null,
    });
  });

  it("survives a network failure at every step", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new Error("ECONNREFUSED");
    });
    const resolved = await resolveAuthorizationServer(MCP, { fetchImpl });
    expect(resolved.metadata).toBeNull();
  });

  // The primitive throws on a 2xx with a malformed body; that must not take
  // the whole resolution down once the earlier strategies have already failed.
  it("does not propagate a malformed legacy discovery document", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async (url) =>
      String(url).includes("oauth-authorization-server")
        ? new Response("<html>", { status: 200 })
        : notFound(),
    );

    const resolved = await resolveAuthorizationServer(MCP, { fetchImpl });
    expect(resolved.metadata).toBeNull();
  });

  it("carries the resource forward even when no issuer resolves", async () => {
    const fetchImpl = routes({
      "https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp": {
        resource: "https://mcp.example.com/api/mcp",
        authorization_servers: ["https://dead.example.com"],
      },
    });

    const resolved = await resolveAuthorizationServer(MCP, { fetchImpl });
    expect(resolved.metadata).toBeNull();
    expect(resolved.resource).toBe("https://mcp.example.com/api/mcp");
  });
});
