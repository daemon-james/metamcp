// Authorization-server resolution for an upstream MCP server.
//
// Composes the URL rules in `discovery-urls.ts` with the network calls, in the
// order the MCP specification requires:
//
//   1. Protected-resource metadata (RFC 9728), located either from the
//      `resource_metadata` parameter of a `WWW-Authenticate` challenge or by
//      probing the well-known URIs.
//   2. The first entry of its `authorization_servers` becomes the issuer.
//   3. Authorization-server metadata for that issuer (RFC 8414 / OIDC), whose
//      `issuer` field must match what we asked for.
//
// Falling back to a bare probe of the MCP server's own origin — the only
// thing this codebase did before — is kept as a last resort, because plenty of
// small servers do host their own authorization endpoints and answer it.

import logger from "../../utils/logger";
import {
  buildAuthorizationServerMetadataUrls,
  buildProtectedResourceMetadataUrls,
  issuerMatches,
} from "./discovery-urls";
import {
  discoverAuthorizationServerMetadata,
  OAuthAuthorizationServerMetadata,
} from "./token-exchange";

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export interface ResolvedAuthorizationServer {
  metadata: OAuthAuthorizationServerMetadata | null;
  /** Issuer the metadata was retrieved from and validated against. */
  issuer: string | null;
  /**
   * Canonical resource identifier for RFC 8707, as declared by the resource
   * server itself. Preferred over one derived from the configured URL: the
   * value the authorization server will match against is the one the resource
   * publishes, which may differ in case, port or trailing slash.
   */
  resource: string | null;
  /** Scopes the resource advertises, used to request the right access. */
  scopesSupported: string[] | null;
}

async function fetchJsonObject(
  url: URL | string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    logger.debug(
      `OAuth discovery: ${String(url)} unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
  if (!response.ok) return null;

  try {
    const data = await response.json();
    return data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    // A candidate that answers 2xx with a non-JSON body is simply not the
    // document we are looking for. Unlike the single-probe primitive, this
    // must not throw: there are more candidates to try.
    logger.debug(`OAuth discovery: ${String(url)} returned a non-JSON body`);
    return null;
  }
}

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;

/**
 * Locate the resource's protected-resource metadata.
 *
 * `resourceMetadataUrl` short-circuits the probing when the server told us
 * where to look on its 401 — always preferable, since it is authoritative and
 * costs one request instead of two.
 */
export async function discoverProtectedResourceMetadata(
  serverUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    resourceMetadataUrl?: string | null;
  } = {},
): Promise<ProtectedResourceMetadata | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const candidates = options.resourceMetadataUrl
    ? [options.resourceMetadataUrl]
    : buildProtectedResourceMetadataUrls(serverUrl);

  for (const candidate of candidates) {
    const data = await fetchJsonObject(candidate, fetchImpl);
    if (!data) continue;
    return {
      resource: typeof data.resource === "string" ? data.resource : undefined,
      authorization_servers: stringArray(data.authorization_servers),
      scopes_supported: stringArray(data.scopes_supported),
    };
  }
  return null;
}

/**
 * Resolve which authorization server governs an MCP server, and how to talk
 * to it.
 *
 * Never throws: every failure degrades to the next strategy and finally to a
 * null metadata, leaving callers on their existing fallbacks.
 */
export async function resolveAuthorizationServer(
  serverUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    resourceMetadataUrl?: string | null;
  } = {},
): Promise<ResolvedAuthorizationServer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const empty: ResolvedAuthorizationServer = {
    metadata: null,
    issuer: null,
    resource: null,
    scopesSupported: null,
  };

  let prm: ProtectedResourceMetadata | null = null;
  try {
    prm = await discoverProtectedResourceMetadata(serverUrl, options);
  } catch (error) {
    logger.warn(
      `Protected-resource metadata lookup failed for ${serverUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const resource = prm?.resource ?? null;
  const scopesSupported = prm?.scopes_supported ?? null;

  for (const issuer of prm?.authorization_servers ?? []) {
    for (const candidate of buildAuthorizationServerMetadataUrls(issuer)) {
      const data = await fetchJsonObject(candidate, fetchImpl);
      if (!data) continue;

      if (!issuerMatches(issuer, data.issuer as string | undefined)) {
        // Refusing this is a security requirement, not tidiness: accepting it
        // would let a resource server nominate an issuer that then hands us
        // endpoints belonging to somebody else.
        logger.warn(
          `Discarding authorization server metadata at ${candidate.href}: ` +
            `issuer "${String(data.issuer)}" does not match "${issuer}"`,
        );
        continue;
      }

      logger.info(
        `Resolved authorization server for ${serverUrl}: ${issuer} (via ${candidate.href})`,
      );
      return {
        metadata: data as OAuthAuthorizationServerMetadata,
        issuer,
        resource,
        scopesSupported,
      };
    }
    logger.warn(
      `No usable authorization server metadata for issuer ${issuer} (declared by ${serverUrl})`,
    );
  }

  // No protected-resource metadata, or none of its issuers resolved. Fall back
  // to the legacy assumption that the MCP server hosts its own authorization
  // endpoints — still true for many self-contained servers.
  try {
    const legacy = await discoverAuthorizationServerMetadata(
      serverUrl,
      fetchImpl,
    );
    if (legacy) {
      return {
        metadata: legacy,
        issuer: legacy.issuer ?? null,
        resource,
        scopesSupported,
      };
    }
  } catch (error) {
    // The primitive throws on a 2xx with a malformed body, which is a genuine
    // upstream bug worth surfacing — but not at the cost of the whole
    // connection when the earlier strategies already told us nothing.
    logger.warn(
      `Authorization server discovery at ${serverUrl} returned a malformed document: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { ...empty, resource, scopesSupported };
}
