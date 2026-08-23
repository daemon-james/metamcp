// Classification for `grant_type=refresh_token` failures, and the registry
// that stops MetaMCP retrying one that can never succeed.
//
// The proactive sweep (`McpServerPool.refreshExpiringTokens`) runs every 60s
// and refreshes any token at or near expiry. An expired token stays expired,
// so a server whose refresh token has been revoked matches that condition on
// every single pass. Observed on Stripe 2026-08-22/23: 976 identical
// `invalid_grant` responses in 12 hours, roughly 1400 a day, none of which
// could ever have worked. Beyond the wasted requests it buries the one fact
// the operator needs, which is that the server requires re-authorization.
//
// RFC 6749 §5.2 splits these cleanly. `invalid_grant` means the refresh token
// is expired, revoked, or was issued to another client; the others named below
// are equally about credentials or a request shape that a retry cannot change.
// Everything else, including `server_error`, `temporarily_unavailable` and any
// code we do not recognise, stays retryable: guessing that an unfamiliar error
// is fatal would strand a server that would have recovered on its own.

const TERMINAL_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
]);

export interface RefreshFailure {
  /** The `error` field of the OAuth error response, if the body had one. */
  oauthError: string | undefined;
  /** HTTP status of the token endpoint response. */
  status: number;
}

/**
 * Can re-sending this refresh request ever succeed without human action?
 *
 * Only an explicit terminal OAuth error code counts. Status alone is not
 * enough: providers return 400 for transient conditions too, and a 5xx is a
 * server-side problem that says nothing about the credential.
 */
export function isTerminalRefreshError({ oauthError }: RefreshFailure): boolean {
  return oauthError !== undefined && TERMINAL_OAUTH_ERRORS.has(oauthError);
}

// serverUuid -> the exact refresh_token that came back terminally rejected.
//
// Keyed by token value, not just server, so re-authorization lifts the block
// on its own: the new grant stores a different refresh_token, which no longer
// matches, and the sweep resumes with no manual reset and no extra DB column.
const deadRefreshTokens = new Map<string, string>();

export function markRefreshTokenDead(
  serverUuid: string,
  refreshToken: string,
): void {
  deadRefreshTokens.set(serverUuid, refreshToken);
}

export function isRefreshTokenKnownDead(
  serverUuid: string,
  refreshToken: string,
): boolean {
  return deadRefreshTokens.get(serverUuid) === refreshToken;
}

export function clearDeadRefreshToken(serverUuid: string): void {
  deadRefreshTokens.delete(serverUuid);
}
