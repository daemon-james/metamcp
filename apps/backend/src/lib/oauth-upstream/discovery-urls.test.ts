import { describe, expect, it } from "vitest";

import {
  buildAuthorizationServerMetadataUrls,
  buildProtectedResourceMetadataUrls,
  issuerMatches,
  parseResourceMetadataUrl,
} from "./discovery-urls";

const hrefs = (urls: URL[]) => urls.map((u) => u.href);

describe("buildProtectedResourceMetadataUrls", () => {
  it("inserts the well-known segment before the resource path", () => {
    expect(
      hrefs(
        buildProtectedResourceMetadataUrls("https://mcp.example.com/api/mcp"),
      ),
    ).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("uses the bare well-known URI when the resource has no path", () => {
    expect(
      hrefs(buildProtectedResourceMetadataUrls("https://mcp.example.com")),
    ).toEqual(["https://mcp.example.com/.well-known/oauth-protected-resource"]);
  });

  it("treats a trailing slash as no path", () => {
    expect(
      hrefs(buildProtectedResourceMetadataUrls("https://mcp.example.com/")),
    ).toEqual(["https://mcp.example.com/.well-known/oauth-protected-resource"]);
  });

  it("preserves a non-default port", () => {
    expect(
      hrefs(buildProtectedResourceMetadataUrls("http://192.168.1.3:8442/sse")),
    ).toEqual([
      "http://192.168.1.3:8442/.well-known/oauth-protected-resource/sse",
      "http://192.168.1.3:8442/.well-known/oauth-protected-resource",
    ]);
  });

  it("returns nothing for an unparseable URL", () => {
    expect(buildProtectedResourceMetadataUrls("not a url")).toEqual([]);
  });
});

describe("buildAuthorizationServerMetadataUrls", () => {
  // The spec fixes this order explicitly for issuers with a path.
  it("tries all three forms in priority order for a path-bearing issuer", () => {
    expect(
      hrefs(
        buildAuthorizationServerMetadataUrls(
          "https://auth.example.com/tenant1",
        ),
      ),
    ).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
  });

  it("uses only the root forms for an issuer without a path", () => {
    expect(
      hrefs(buildAuthorizationServerMetadataUrls("https://auth.example.com")),
    ).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  it("treats a trailing slash as no path", () => {
    expect(
      hrefs(buildAuthorizationServerMetadataUrls("https://auth.example.com/")),
    ).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  it("handles a multi-segment issuer path", () => {
    expect(
      hrefs(
        buildAuthorizationServerMetadataUrls("https://login.example.com/a/b"),
      ),
    ).toEqual([
      "https://login.example.com/.well-known/oauth-authorization-server/a/b",
      "https://login.example.com/.well-known/openid-configuration/a/b",
      "https://login.example.com/a/b/.well-known/openid-configuration",
    ]);
  });

  it("returns nothing for an unparseable issuer", () => {
    expect(buildAuthorizationServerMetadataUrls("")).toEqual([]);
  });
});

describe("parseResourceMetadataUrl", () => {
  it("extracts a quoted resource_metadata parameter", () => {
    expect(
      parseResourceMetadataUrl(
        'Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
      ),
    ).toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
  });

  it("extracts an unquoted resource_metadata parameter", () => {
    expect(
      parseResourceMetadataUrl(
        "Bearer resource_metadata=https://mcp.example.com/.well-known/oauth-protected-resource",
      ),
    ).toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
  });

  it("is case-insensitive on the parameter name", () => {
    expect(
      parseResourceMetadataUrl(
        'Bearer Resource_Metadata="https://a.example.com/prm"',
      ),
    ).toBe("https://a.example.com/prm");
  });

  it("ignores challenges without the parameter", () => {
    expect(
      parseResourceMetadataUrl('Bearer realm="mcp", error="invalid_token"'),
    ).toBeNull();
    expect(parseResourceMetadataUrl(null)).toBeNull();
    expect(parseResourceMetadataUrl(undefined)).toBeNull();
    expect(parseResourceMetadataUrl("")).toBeNull();
  });

  it("rejects a value that is not a URL", () => {
    expect(
      parseResourceMetadataUrl('Bearer resource_metadata="/relative/path"'),
    ).toBeNull();
  });
});

describe("issuerMatches", () => {
  it("accepts an exact match", () => {
    expect(
      issuerMatches("https://auth.example.com", "https://auth.example.com"),
    ).toBe(true);
  });

  it("ignores a trailing slash on either side", () => {
    expect(
      issuerMatches("https://auth.example.com/", "https://auth.example.com"),
    ).toBe(true);
    expect(
      issuerMatches("https://auth.example.com", "https://auth.example.com/"),
    ).toBe(true);
  });

  // The whole point: a resource server must not be able to point us at an
  // issuer that then claims to be someone else.
  it("rejects a different host", () => {
    expect(
      issuerMatches("https://auth.example.com", "https://evil.example.com"),
    ).toBe(false);
  });

  it("rejects a different path", () => {
    expect(
      issuerMatches(
        "https://auth.example.com/tenant1",
        "https://auth.example.com/tenant2",
      ),
    ).toBe(false);
  });

  it("rejects a missing issuer", () => {
    expect(issuerMatches("https://auth.example.com", undefined)).toBe(false);
  });
});
