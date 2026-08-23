// Server-side refresh-on-401 helper for the upstream proxy path.
//
// The backend's MCP client (`apps/backend/src/lib/metamcp/client.ts`) does
// not pass an OAuthClientProvider into the SDK transports, so the SDK has
// no built-in path to refresh tokens when the upstream returns 401. This
// helper closes that gap: it reads the persisted oauth_sessions row,
// POSTs `grant_type=refresh_token` to the upstream's token endpoint, and
// persists the new tokens back into the DB so the next connection attempt
// picks them up.
//
// Concurrency: an in-process per-server mutex (`inFlightRefreshes`)
// collapses simultaneous refresh attempts for the same MCP server into
// one upstream POST. Without this, providers that rotate refresh tokens
// (Google, Microsoft, Okta with rotation enabled) would consume the
// refresh_token on the first attempt and reject the second with
// `invalid_grant`, leaving one of the two connections stranded. The
// mutex is in-process only; multi-instance deployments still race across
// processes (acceptable cost for now — a DB-level CAS would be the
// follow-up).
//
// Acceptance criterion #3 from the OAuth-CORS-fix PR.

import { ServerParameters } from "@repo/zod-types";

import { oauthSessionsRepository } from "../../db/repositories";
import logger from "../../utils/logger";
import { resolveAuthorizationServer } from "./discovery";
import {
  canonicalResourceUri,
  OAuthTokens,
  redactToken,
  refreshAccessToken,
  resolveTokenEndpoint,
  resolveTokenEndpointAuthMethod,
  UpstreamTokenError,
} from "./token-exchange";
import {
  isRefreshTokenKnownDead,
  isTerminalRefreshError,
  markRefreshTokenDead,
} from "./terminal-refresh-error";
import { checkTokenExpiry, DEFAULT_REFRESH_SKEW_SECONDS } from "./token-expiry";

export interface RefreshResult {
  status:
    | "refreshed"
    | "no_refresh_token"
    | "no_session"
    | "no_client_id"
    | "needs_reauthorization"
    | "failed";
  tokens?: OAuthTokens;
  error?: string;
  errorDescription?: string;
  upstreamStatus?: number;
}

// Per-server in-flight refresh promises. Concurrent callers for the same
// MCP server share the same upstream POST instead of racing on rotating
// refresh tokens. The map is cleared in a `finally` so a refresh failure
// doesn't permanently pin the server. Exposed for tests; do not depend on
// it from production code.
export const inFlightRefreshes = new Map<string, Promise<RefreshResult>>();

// Attempt to refresh upstream OAuth tokens for an MCP server. Returns a
// status describing what happened. Persists new tokens on success.
//
// NOTE: This is intentionally safe to call repeatedly — it short-circuits
// when there is no refresh_token or no client_id to use.
export async function tryRefreshUpstreamTokens(
  serverParams: Pick<ServerParameters, "uuid" | "name" | "url">,
): Promise<RefreshResult> {
  const inFlight = inFlightRefreshes.get(serverParams.uuid);
  if (inFlight) {
    logger.info(
      `[oauth] refresh already in flight for ${serverParams.uuid}; joining`,
    );
    return inFlight;
  }
  const promise = (async () => {
    try {
      return await doRefresh(serverParams);
    } finally {
      inFlightRefreshes.delete(serverParams.uuid);
    }
  })();
  inFlightRefreshes.set(serverParams.uuid, promise);
  return promise;
}

async function doRefresh(
  serverParams: Pick<ServerParameters, "uuid" | "name" | "url">,
): Promise<RefreshResult> {
  if (!serverParams.url) {
    return { status: "no_session" };
  }

  const session = await oauthSessionsRepository.findByMcpServerUuid(
    serverParams.uuid,
  );
  if (!session) {
    return { status: "no_session" };
  }

  const currentTokens = session.tokens as
    | (OAuthTokens & { refresh_token?: string })
    | null;
  if (!currentTokens?.refresh_token) {
    return { status: "no_refresh_token" };
  }

  // Refuse a grant the authorization server has already rejected as final.
  // Placed here rather than in refreshIfExpiring so it covers the 401-recovery
  // path too (`client.ts`): a 401 carrying a revoked refresh token is no more
  // recoverable than an expiry sweep is. Keyed on the token value, so the
  // block lifts by itself once re-authorization stores a new one.
  if (isRefreshTokenKnownDead(serverParams.uuid, currentTokens.refresh_token)) {
    return {
      status: "needs_reauthorization",
      error: "invalid_grant",
      errorDescription:
        "Refresh token was rejected as final; re-authorize this server.",
    };
  }

  const clientInformation = session.client_information as Record<
    string,
    unknown
  > | null;
  const clientId =
    clientInformation && typeof clientInformation.client_id === "string"
      ? (clientInformation.client_id as string)
      : null;
  if (!clientId) {
    return { status: "no_client_id" };
  }
  const clientSecret =
    typeof clientInformation?.client_secret === "string"
      ? (clientInformation.client_secret as string)
      : undefined;

  // Full discovery chain: protected-resource metadata names the issuer, whose
  // own metadata carries the token endpoint. Falls back to the MCP server's
  // origin for servers that host their own endpoints.
  const resolved = await resolveAuthorizationServer(serverParams.url);
  const discovered = resolved.metadata;
  const tokenEndpoint = resolveTokenEndpoint({
    clientInformation,
    discovered,
    serverUrl: serverParams.url,
  });
  const authMethod = resolveTokenEndpointAuthMethod({
    clientInformation,
    discovered,
    hasSecret: Boolean(clientSecret),
  });

  logger.info(
    `[oauth] proxy 401 → refreshing tokens — server=${serverParams.uuid} ` +
      `(${serverParams.name}) token_endpoint=${tokenEndpoint} ` +
      `auth_method=${authMethod} ` +
      `refresh_token=${redactToken(currentTokens.refresh_token)}`,
  );

  let newTokens: OAuthTokens;
  try {
    newTokens = await refreshAccessToken({
      tokenEndpoint,
      refreshToken: currentTokens.refresh_token,
      clientId,
      clientSecret,
      authMethod,
      scope:
        typeof currentTokens.scope === "string"
          ? currentTokens.scope
          : undefined,
      // Prefer the identifier the resource publishes for itself; the
      // authorization server matches against that exact string.
      resource: resolved.resource ?? canonicalResourceUri(serverParams.url),
    });
  } catch (error) {
    if (error instanceof UpstreamTokenError) {
      const oauthError = error.oauthError?.error;
      const terminal = isTerminalRefreshError({
        oauthError,
        status: error.status,
      });

      if (terminal) {
        // Pin this exact refresh_token as dead so the 60s sweep stops
        // re-POSTing a grant the authorization server has already rejected as
        // final. Re-authorization stores a different token and lifts the block
        // on its own.
        markRefreshTokenDead(serverParams.uuid, currentTokens.refresh_token);
        logger.error(
          `[oauth] refresh token rejected as final — server=${serverParams.uuid} ` +
            `(${serverParams.name}) status=${error.status} ` +
            `error=${oauthError ?? "unknown"}. Re-authorize this server; ` +
            `MetaMCP will not retry until its credentials change.`,
        );
        return {
          status: "needs_reauthorization",
          error: oauthError ?? "upstream_error",
          errorDescription:
            error.oauthError?.error_description ?? error.message,
          upstreamStatus: error.status,
        };
      }

      logger.warn(
        `[oauth] proxy refresh failed — server=${serverParams.uuid} ` +
          `status=${error.status} error=${oauthError ?? "unknown"}`,
      );
      return {
        status: "failed",
        error: oauthError ?? "upstream_error",
        errorDescription: error.oauthError?.error_description ?? error.message,
        upstreamStatus: error.status,
      };
    }
    logger.error(
      `[oauth] proxy refresh threw — server=${serverParams.uuid}:`,
      error,
    );
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "internal_error",
    };
  }

  await oauthSessionsRepository.upsert({
    mcp_server_uuid: serverParams.uuid,
    tokens: newTokens,
  });

  logger.info(
    `[oauth] proxy refresh succeeded — server=${serverParams.uuid} ` +
      `access_token=${redactToken(newTokens.access_token)}`,
  );

  return { status: "refreshed", tokens: newTokens };
}

// Refresh only if the stored token is at or near expiry. Safe to call on any
// server and on any cadence: it reads one row, and the underlying refresh is
// mutex-collapsed, so overlapping callers share a single upstream POST.
export async function refreshIfExpiring(
  serverParams: Pick<ServerParameters, "uuid" | "name" | "url">,
  skewSeconds: number = DEFAULT_REFRESH_SKEW_SECONDS,
): Promise<RefreshResult | null> {
  const session = await oauthSessionsRepository.findByMcpServerUuid(
    serverParams.uuid,
  );
  const { expiresAt, shouldRefresh } = checkTokenExpiry(
    session ?? null,
    skewSeconds,
  );
  if (!shouldRefresh) return null;

  const currentTokens = session?.tokens as
    | (OAuthTokens & { refresh_token?: string })
    | null
    | undefined;

  // Check before announcing. doRefresh() blocks a known-dead grant too, but it
  // does so after this line has already claimed a refresh is under way, and an
  // expired token satisfies shouldRefresh on every 60s pass. Left alone that
  // prints a refresh that never happens, once a minute, forever.
  const refreshToken = currentTokens?.refresh_token;
  if (
    typeof refreshToken === "string" &&
    isRefreshTokenKnownDead(serverParams.uuid, refreshToken)
  ) {
    return {
      status: "needs_reauthorization",
      error: "invalid_grant",
      errorDescription:
        "Refresh token was rejected as final; re-authorize this server.",
    };
  }

  logger.info(
    `[oauth] token for ${serverParams.name} (${serverParams.uuid}) expires at ` +
      `${expiresAt?.toISOString()}; refreshing ahead of expiry`,
  );
  return tryRefreshUpstreamTokens(serverParams);
}

export { checkTokenExpiry, DEFAULT_REFRESH_SKEW_SECONDS } from "./token-expiry";
