// URL construction for OAuth discovery. Pure — no network, no database — so
// the ordering rules below can be tested exhaustively.
//
// Before this existed, the only discovery MetaMCP performed as a client was a
// single probe of `/.well-known/oauth-authorization-server` at the MCP
// server's origin root. That assumes the authorization server is the resource
// server, which is true only for the simplest deployments. Anything fronted by
// a separate identity provider — Atlassian, or any server behind Auth0, Okta
// or Entra — returned nothing, discovery yielded null, and the token endpoint
// fell back to `https://<mcp-host>/token`: a URL that both belongs to the
// wrong host and discards the server's own path.

/**
 * RFC 9728 §3.1: the protected-resource metadata URL is formed by inserting
 * `/.well-known/oauth-protected-resource` between the resource's host and its
 * path. A resource with no path uses the well-known URI on its own.
 *
 * Both forms are returned, path-suffixed first, because deployments differ on
 * whether they serve the metadata per-path or once per origin.
 */
export function buildProtectedResourceMetadataUrls(serverUrl: string): URL[] {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return [];
  }

  const path = url.pathname.replace(/\/+$/, "");
  const candidates: URL[] = [];

  if (path && path !== "/") {
    candidates.push(
      new URL(`/.well-known/oauth-protected-resource${path}`, url.origin),
    );
  }
  candidates.push(new URL("/.well-known/oauth-protected-resource", url.origin));

  return dedupe(candidates);
}

/**
 * Authorization-server metadata URLs for an issuer, in the priority order the
 * MCP specification mandates.
 *
 * For an issuer carrying a path component the spec is explicit that all three
 * forms must be tried, in this order: the RFC 8414 path-insertion form, the
 * OpenID Connect path-insertion form, then the OIDC path-appending form. An
 * issuer without a path has only the two root forms.
 */
export function buildAuthorizationServerMetadataUrls(issuer: string): URL[] {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return [];
  }

  const path = url.pathname.replace(/\/+$/, "");
  const candidates: URL[] = [];

  if (path && path !== "/") {
    candidates.push(
      new URL(`/.well-known/oauth-authorization-server${path}`, url.origin),
      new URL(`/.well-known/openid-configuration${path}`, url.origin),
      new URL(`${path}/.well-known/openid-configuration`, url.origin),
    );
  } else {
    candidates.push(
      new URL("/.well-known/oauth-authorization-server", url.origin),
      new URL("/.well-known/openid-configuration", url.origin),
    );
  }

  return dedupe(candidates);
}

/**
 * Pull `resource_metadata` out of a `WWW-Authenticate` challenge.
 *
 * RFC 9728 §5.1 has the resource server advertise its metadata location on the
 * 401 itself, which is both faster and more reliable than guessing well-known
 * URLs. The parameter may be quoted or bare, and the scheme and other
 * parameters vary, so match on the parameter rather than trying to parse the
 * whole challenge.
 */
export function parseResourceMetadataUrl(
  wwwAuthenticate: string | null | undefined,
): string | null {
  if (!wwwAuthenticate) return null;
  const match = /resource_metadata\s*=\s*("([^"]*)"|([^\s,]+))/i.exec(
    wwwAuthenticate,
  );
  const value = match?.[2] ?? match?.[3];
  if (!value) return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

/**
 * An authorization server's metadata is only trustworthy when its `issuer`
 * matches the identifier used to construct the well-known URL — otherwise a
 * resource server could name any issuer and have us send credentials there.
 * The spec states the client MUST NOT use metadata whose issuer differs.
 *
 * Compared without a trailing slash: issuers are frequently written both ways
 * and the difference is not meaningful.
 */
export function issuerMatches(
  expected: string,
  actual: string | undefined,
): boolean {
  if (!actual) return false;
  const normalize = (value: string) => value.replace(/\/+$/, "");
  return normalize(expected) === normalize(actual);
}

function dedupe(urls: URL[]): URL[] {
  const seen = new Set<string>();
  return urls.filter((url) => {
    if (seen.has(url.href)) return false;
    seen.add(url.href);
    return true;
  });
}
