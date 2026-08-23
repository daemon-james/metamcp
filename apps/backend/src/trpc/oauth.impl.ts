import { registerClient } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthClientInformation } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  DiscoverOAuthRequestSchema,
  DiscoverOAuthResponseSchema,
  ExchangeOAuthTokenRequestSchema,
  ExchangeOAuthTokenResponseSchema,
  GetOAuthSessionRequestSchema,
  GetOAuthSessionResponseSchema,
  McpServerErrorStatusEnum,
  OAuthClientInformationSchema,
  RefreshOAuthTokenRequestSchema,
  RefreshOAuthTokenResponseSchema,
  RegisterOAuthClientRequestSchema,
  RegisterOAuthClientResponseSchema,
  UpsertOAuthSessionRequestSchema,
  UpsertOAuthSessionResponseSchema,
} from "@repo/zod-types";
import { z } from "zod";

import logger from "@/utils/logger";

import {
  mcpServersRepository,
  oauthSessionsRepository,
} from "../db/repositories";
import { OAuthSessionsSerializer } from "../db/serializers";
import { resolveAuthorizationServer } from "../lib/oauth-upstream/discovery";
import { tryRefreshUpstreamTokens } from "../lib/oauth-upstream/refresh-on-401";
import {
  canonicalResourceUri,
  exchangeAuthorizationCode,
  OAuthTokens,
  redactToken,
  resolveTokenEndpoint,
  resolveTokenEndpointAuthMethod,
  UpstreamTokenError,
} from "../lib/oauth-upstream/token-exchange";

// The redirect_uri passed in the token request MUST byte-match the one the
// SDK sent on the /authorize call. The frontend computes it as
// `getAppUrl() + "/fe-oauth/callback"` with no normalization
// (apps/frontend/lib/oauth-provider.ts), so we mirror that verbatim — no
// trailing-slash stripping. If APP_URL ends in a slash, both sides produce
// a double slash; the only requirement is that the two values match.
function resolveRedirectUri(): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    throw new Error(
      "APP_URL environment variable is required for OAuth callback resolution",
    );
  }
  return appUrl + "/fe-oauth/callback";
}

function clientInfoAsRecord(
  ci: OAuthClientInformation | null | undefined,
): Record<string, unknown> | null {
  if (!ci) return null;
  return ci as unknown as Record<string, unknown>;
}

function upstreamErrorResponse(error: UpstreamTokenError) {
  return {
    success: false as const,
    error: error.oauthError?.error ?? "upstream_error",
    error_description: error.oauthError?.error_description ?? error.message,
    upstream_status: error.status,
  };
}

// Authorize the caller against the referenced MCP server and resolve its
// upstream URL from the database.
//
// SECURITY: this function exists so the upstream URL is *never* taken
// from a caller-supplied input. Doing so would allow any authenticated
// user to direct MetaMCP's server-side fetch (and the OAuth code +
// client_secret it carries) at an attacker-controlled host.
//
// The function returns one of:
//   { ok: true, url } — owned/public server with a valid HTTP(S) URL
//   { ok: false, error } — typed error envelope safe to return to caller
type ResolveServerResult =
  | { ok: true; url: string }
  | { ok: false; error: { error: string; error_description: string } };

async function resolveOwnedServerUrl(
  mcpServerUuid: string,
  userId: string,
): Promise<ResolveServerResult> {
  const server = await mcpServersRepository.findByUuid(mcpServerUuid);
  if (!server) {
    return {
      ok: false,
      error: {
        error: "server_not_found",
        error_description: "MCP server not found",
      },
    };
  }
  // Match the access rules used elsewhere: a server with a `user_id` is
  // private to that user; a server with `user_id === null` is public.
  if (server.user_id && server.user_id !== userId) {
    return {
      ok: false,
      error: {
        error: "access_denied",
        error_description:
          "You can only run OAuth flows against servers you own",
      },
    };
  }
  if (
    !server.url ||
    server.type === "STDIO" ||
    !/^https?:\/\//i.test(server.url)
  ) {
    return {
      ok: false,
      error: {
        error: "server_not_oauth_capable",
        error_description:
          "This MCP server is not an HTTP-style server, so OAuth flows are not applicable.",
      },
    };
  }
  return { ok: true, url: server.url };
}

export const oauthImplementations = {
  get: async (
    input: z.infer<typeof GetOAuthSessionRequestSchema>,
  ): Promise<z.infer<typeof GetOAuthSessionResponseSchema>> => {
    try {
      const session = await oauthSessionsRepository.findByMcpServerUuid(
        input.mcp_server_uuid,
      );

      if (!session) {
        return {
          success: false as const,
          message: "OAuth session not found",
        };
      }

      return {
        success: true as const,
        data: OAuthSessionsSerializer.serializeOAuthSession(session),
        message: "OAuth session retrieved successfully",
      };
    } catch (error) {
      logger.error("Error fetching OAuth session:", error);
      return {
        success: false as const,
        message: "Failed to fetch OAuth session",
      };
    }
  },

  upsert: async (
    input: z.infer<typeof UpsertOAuthSessionRequestSchema>,
  ): Promise<z.infer<typeof UpsertOAuthSessionResponseSchema>> => {
    try {
      const session = await oauthSessionsRepository.upsert({
        mcp_server_uuid: input.mcp_server_uuid,
        ...(input.client_information && {
          client_information: input.client_information,
        }),
        ...(input.tokens && { tokens: input.tokens }),
        ...(input.code_verifier && { code_verifier: input.code_verifier }),
        // CSRF-defence nonce (#299). MUST be forwarded — omitting it here
        // silently disables state validation at `exchangeToken` because the
        // DB column stays NULL and the validator takes the back-compat
        // bypass. Pinned by the "forwards expected_state to the repo" test.
        ...(input.expected_state && {
          expected_state: input.expected_state,
        }),
      });

      if (!session) {
        return {
          success: false as const,
          error: "Failed to upsert OAuth session",
        };
      }

      return {
        success: true as const,
        data: OAuthSessionsSerializer.serializeOAuthSession(session),
        message: "OAuth session upserted successfully",
      };
    } catch (error) {
      logger.error("Error upserting OAuth session:", error);
      return {
        success: false as const,
        error: error instanceof Error ? error.message : "Internal server error",
      };
    }
  },

  // Server-side authorization-code-to-token exchange.
  //
  // The frontend's /fe-oauth/callback page forwards the authorization code
  // here instead of running the SDK's `exchangeAuthorization` in the
  // browser, because most enterprise OAuth providers (Salesforce, Okta,
  // Auth0, Microsoft Entra, ServiceNow, ...) do not return CORS headers
  // on their token endpoints. The fetch succeeds on the wire but the
  // browser blocks the response body, leaving tokens unpersisted.
  exchangeToken: async (
    input: z.infer<typeof ExchangeOAuthTokenRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof ExchangeOAuthTokenResponseSchema>> => {
    // Resolve the upstream URL from the DB (NOT from the request). This is
    // the SSRF guard: an attacker-supplied URL would otherwise steer the
    // discovery + token POST at an attacker-controlled host, leaking the
    // authorization code, PKCE verifier, client_id, and client_secret.
    const serverResolution = await resolveOwnedServerUrl(
      input.mcp_server_uuid,
      userId,
    );
    if (!serverResolution.ok) {
      return { success: false as const, ...serverResolution.error };
    }
    const serverUrl = serverResolution.url;

    const session = await oauthSessionsRepository.findByMcpServerUuid(
      input.mcp_server_uuid,
    );
    if (!session) {
      return {
        success: false as const,
        error: "session_not_found",
        error_description:
          "No OAuth session found for this MCP server. The authorize flow may have been started against a different server.",
      };
    }
    if (!session.code_verifier) {
      return {
        success: false as const,
        error: "code_verifier_missing",
        error_description:
          "OAuth session has no code_verifier. The authorize flow must be re-initiated.",
      };
    }

    // RFC 6749 §10.12 CSRF defence. `expected_state` was persisted at the
    // authorize-redirect step by `DbOAuthClientProvider.state()`. Three
    // cases:
    //
    //   - expected_state IS NULL → flow started before this column existed,
    //     OR a previous exchange already cleared it (replay). Accept for
    //     backward compat with in-flight pre-fix flows; the column will be
    //     populated on the NEXT authorize attempt and validated then.
    //   - expected_state non-null AND matches input.state → proceed; clear
    //     the column AFTER successful upstream exchange so the row can't
    //     be replayed.
    //   - expected_state non-null AND input.state missing OR mismatched →
    //     fail-closed. Includes the missing case explicitly: an attacker
    //     who omits state must not bypass the check by triggering a
    //     truthy-undefined comparison.
    //
    // Validation runs BEFORE the upstream POST so a mismatch leaks no
    // authorization code to a third party.
    if (session.expected_state) {
      if (!input.state || input.state !== session.expected_state) {
        logger.warn(
          `[oauth] state mismatch — server=${input.mcp_server_uuid} ` +
            `expected_present=true got_present=${Boolean(input.state)}`,
        );
        return {
          success: false as const,
          error: "invalid_state",
          error_description:
            "OAuth state mismatch — possible CSRF. The authorize flow must be re-initiated.",
        };
      }
    }
    const clientInformation = clientInfoAsRecord(session.client_information);
    const clientId =
      clientInformation && typeof clientInformation.client_id === "string"
        ? (clientInformation.client_id as string)
        : null;
    if (!clientId) {
      return {
        success: false as const,
        error: "client_information_missing",
        error_description:
          "OAuth session has no client_id. Dynamic registration may have failed, or the pre-registered OAuth client form was not filled in.",
      };
    }

    const clientSecret =
      typeof clientInformation?.client_secret === "string"
        ? (clientInformation.client_secret as string)
        : undefined;

    const resolvedAs = await resolveAuthorizationServer(serverUrl);
    const discovered = resolvedAs.metadata;
    const tokenEndpoint = resolveTokenEndpoint({
      clientInformation,
      discovered,
      serverUrl,
    });
    const authMethod = resolveTokenEndpointAuthMethod({
      clientInformation,
      discovered,
      hasSecret: Boolean(clientSecret),
    });

    const redirectUri = resolveRedirectUri();

    logger.info(
      `[oauth] exchanging code for tokens — server=${input.mcp_server_uuid} ` +
        `token_endpoint=${tokenEndpoint} auth_method=${authMethod} ` +
        `code=${redactToken(input.code)}`,
    );

    let tokens: OAuthTokens;
    try {
      tokens = await exchangeAuthorizationCode({
        tokenEndpoint,
        code: input.code,
        codeVerifier: session.code_verifier,
        redirectUri,
        clientId,
        clientSecret,
        authMethod,
        // RFC 8707. `serverUrl` is the DB-resolved URL, never caller input,
        // so this cannot be steered at an attacker-chosen audience.
        resource: resolvedAs.resource ?? canonicalResourceUri(serverUrl),
      });
    } catch (error) {
      if (error instanceof UpstreamTokenError) {
        logger.warn(
          `[oauth] upstream token exchange failed — server=${input.mcp_server_uuid} ` +
            `status=${error.status} error=${error.oauthError?.error ?? "unknown"}`,
        );
        return upstreamErrorResponse(error);
      }
      // Any other thrown value is a programmer bug, not an upstream issue.
      // Surface it via logger.error and re-throw so tRPC returns a 500 to
      // the caller instead of masking it as `internal_error`.
      logger.error(
        `[oauth] exchangeToken unexpected error for server ${input.mcp_server_uuid}:`,
        error,
      );
      throw error;
    }

    await oauthSessionsRepository.upsert({
      mcp_server_uuid: input.mcp_server_uuid,
      tokens,
    });

    // One-shot clear: with the upstream exchange successful, the
    // `expected_state` nonce has served its purpose. Clearing it now
    // ensures a replay of the same `code`+`state` pair would fall through
    // the back-compat NULL branch on a second exchange attempt — but since
    // the `code` itself is already burned by the upstream, the replay
    // would fail with `invalid_grant` anyway. Belt-and-braces.
    //
    // Only runs on SUCCESS — an upstream error returns above without
    // clearing, so the user can retry the exchange without re-running the
    // authorize flow.
    try {
      await oauthSessionsRepository.clearExpectedState(input.mcp_server_uuid);
    } catch (clearError) {
      // Logging only — the exchange itself already succeeded and a stale
      // expected_state will be overwritten on the next authorize attempt.
      logger.warn(
        `[oauth] failed to clear expected_state after successful exchange ` +
          `— server=${input.mcp_server_uuid}: ${
            clearError instanceof Error ? clearError.message : "unknown"
          }`,
      );
    }

    // Fresh credentials are exactly the recovery an ERROR-flagged server was
    // waiting for. Clear the flag so the pool's 60s health check picks the
    // server back up — `connectMetaMcpClient` reloads tokens from the database
    // on connect, so it will use these. Without this the server would stay
    // flagged, stay out of the namespace pool, and never be re-dialled, making
    // a successful re-authorisation look like it did nothing.
    //
    // Writing through the repository rather than `serverErrorTracker` keeps
    // this module off `config.service`'s import chain (which opens the DB at
    // import time). The tracker's other job — the in-memory crash counter —
    // is STDIO-only and irrelevant to an OAuth server.
    try {
      await mcpServersRepository.updateServerErrorStatus({
        serverUuid: input.mcp_server_uuid,
        errorStatus: McpServerErrorStatusEnum.enum.NONE,
      });
    } catch (resetError) {
      logger.warn(
        `[oauth] failed to clear error status after successful exchange ` +
          `— server=${input.mcp_server_uuid}: ${
            resetError instanceof Error ? resetError.message : "unknown"
          }`,
      );
    }

    logger.info(
      `[oauth] token exchange succeeded — server=${input.mcp_server_uuid} ` +
        `access_token=${redactToken(tokens.access_token)} ` +
        `refresh_token=${redactToken(tokens.refresh_token)}`,
    );

    return {
      success: true as const,
      message: "OAuth tokens persisted",
    };
  },

  // Server-side refresh-token grant. Companion to exchangeToken — same CORS
  // rationale. Reads the current refresh_token from oauth_sessions, POSTs
  // to the upstream token endpoint, persists the new tokens (preserving the
  // refresh_token if the response omits it).
  // tRPC frontend mutation. Delegates to the shared refresh primitive so
  // an in-process mutex collapses simultaneous refresh attempts (including
  // a proxy 401 retry) into a single upstream POST. Without the mutex,
  // providers that rotate refresh tokens would consume the token on the
  // first call and reject the second with `invalid_grant`.
  refreshToken: async (
    input: z.infer<typeof RefreshOAuthTokenRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof RefreshOAuthTokenResponseSchema>> => {
    const serverResolution = await resolveOwnedServerUrl(
      input.mcp_server_uuid,
      userId,
    );
    if (!serverResolution.ok) {
      return { success: false as const, ...serverResolution.error };
    }

    const result = await tryRefreshUpstreamTokens({
      uuid: input.mcp_server_uuid,
      name: "frontend-refresh",
      url: serverResolution.url,
    });

    switch (result.status) {
      case "refreshed":
        return { success: true as const, message: "OAuth tokens refreshed" };
      case "no_session":
        return {
          success: false as const,
          error: "session_not_found",
          error_description: "No OAuth session for this MCP server.",
        };
      case "no_refresh_token":
        return {
          success: false as const,
          error: "no_refresh_token",
          error_description:
            "OAuth session has no refresh_token; the user must re-authorize.",
        };
      case "no_client_id":
        return {
          success: false as const,
          error: "client_information_missing",
          error_description:
            "OAuth session has no client_id; cannot refresh tokens.",
        };
      case "needs_reauthorization":
        // The authorization server rejected the refresh token as final
        // (RFC 6749 5.2). Retrying cannot help and MetaMCP has stopped
        // trying, so tell the caller the one thing that does: re-authorize.
        // Always state the action. The upstream often sends no
        // error_description, in which case tryRefreshUpstreamTokens falls back
        // to the error message, which is the bare code again: a user shown
        // "invalid_grant" learns nothing about what to do. Keep any real
        // upstream detail, but never let it stand alone.
        return {
          success: false as const,
          error: result.error ?? "invalid_grant",
          error_description: [
            "The refresh token was rejected as final. Re-authorize this server.",
            result.errorDescription && result.errorDescription !== result.error
              ? `Upstream said: ${result.errorDescription}`
              : null,
          ]
            .filter(Boolean)
            .join(" "),
          upstream_status: result.upstreamStatus,
        };
      case "failed":
        return {
          success: false as const,
          error: result.error ?? "upstream_error",
          error_description: result.errorDescription,
          upstream_status: result.upstreamStatus,
        };
    }
  },
  // Dynamic client registration, run server-side.
  //
  // The browser cannot do this itself: providers such as Sentry answer the
  // CORS preflight on /oauth/register with 204 and no
  // Access-Control-Allow-Origin, so the fetch is blocked before it is sent.
  // The SDK's auth() then throws, useConnection's handleAuthError propagates
  // it, and the UI shows "Connection Error" with no redirect — the Connect
  // button appears to do nothing. Same rationale as exchangeToken below.
  //
  // The upstream URL comes from the mcp_servers row (never the request) via
  // resolveOwnedServerUrl, which also enforces ownership — otherwise this
  // would be an SSRF primitive.
  register: async (
    input: z.infer<typeof RegisterOAuthClientRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof RegisterOAuthClientResponseSchema>> => {
    const serverResolution = await resolveOwnedServerUrl(
      input.mcp_server_uuid,
      userId,
    );
    if (!serverResolution.ok) {
      return { success: false as const, ...serverResolution.error };
    }
    const serverUrl = serverResolution.url;

    try {
      const metadata = (await resolveAuthorizationServer(serverUrl)).metadata;
      if (!metadata) {
        return {
          success: false as const,
          error: "discovery_failed",
          error_description: `No authorization server metadata at ${serverUrl}`,
        };
      }
      const clientInformation = await registerClient(serverUrl, {
        metadata: metadata as never,
        clientMetadata: input.client_metadata as never,
      });

      const parsed = OAuthClientInformationSchema.parse(clientInformation);
      await oauthSessionsRepository.upsert({
        mcp_server_uuid: input.mcp_server_uuid,
        client_information: parsed,
      });

      return { success: true as const, data: parsed };
    } catch (error) {
      return {
        success: false as const,
        error: "registration_failed",
        error_description:
          error instanceof Error ? error.message : String(error),
      };
    }
  },

  // Server-side RFC 9728 + RFC 8414 discovery for the browser OAuth
  // provider. The SDK's auth() prefers provider.discoveryState() over
  // fetching well-known documents from the page origin. Providers that
  // omit CORS on those documents (Plecto) otherwise fall back to
  // `{origin}/authorize` and the user sees a 404.
  discover: async (
    input: z.infer<typeof DiscoverOAuthRequestSchema>,
    userId: string,
  ): Promise<z.infer<typeof DiscoverOAuthResponseSchema>> => {
    const serverResolution = await resolveOwnedServerUrl(
      input.mcp_server_uuid,
      userId,
    );
    if (!serverResolution.ok) {
      return { success: false as const, ...serverResolution.error };
    }
    const serverUrl = serverResolution.url;

    try {
      const resolved = await resolveAuthorizationServer(serverUrl);
      const authorizationEndpoint = resolved.metadata?.authorization_endpoint;
      if (!resolved.metadata || !authorizationEndpoint) {
        return {
          success: false as const,
          error: "discovery_failed",
          error_description: `No authorization server metadata at ${serverUrl}`,
        };
      }

      const authorizationServerUrl =
        resolved.issuer ?? new URL(authorizationEndpoint).origin;

      return {
        success: true as const,
        data: {
          authorizationServerUrl,
          resourceMetadataUrl: new URL(
            "/.well-known/oauth-protected-resource",
            serverUrl,
          ).href,
          resourceMetadata: {
            ...(resolved.resource ? { resource: resolved.resource } : {}),
            ...(resolved.issuer
              ? { authorization_servers: [resolved.issuer] }
              : {}),
            ...(resolved.scopesSupported
              ? { scopes_supported: resolved.scopesSupported }
              : {}),
          },
          // `authorizationEndpoint` was narrowed to a non-empty string above.
          // Spreading it back in is what proves to the type system that the
          // document satisfies the schema's required `authorization_endpoint`,
          // which the SDK's startAuthorization reads.
          authorizationServerMetadata: {
            ...resolved.metadata,
            authorization_endpoint: authorizationEndpoint,
          },
        },
      };
    } catch (error) {
      return {
        success: false as const,
        error: "discovery_failed",
        error_description:
          error instanceof Error ? error.message : String(error),
      };
    }
  },
};
