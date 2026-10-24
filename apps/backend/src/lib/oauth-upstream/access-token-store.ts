// The access token each OAuth-protected upstream server should be sent right
// now, keyed by MCP server UUID.
//
// A backend connection outlives its access token. Pooled connections are
// handed from session to session, recycled into the idle pool, and shared
// between sessions once the per-server cap is reached, so one transport can
// stay in use for many hours while the provider issues a new access token
// every hour. The transports therefore read the token from here on every
// request (see `createOAuthFetch`) instead of keeping the one they were built
// with.
//
// Written by every path that learns of a newer token: a successful refresh
// (proactive sweep, connect-time renewal, 401 recovery, the UI's refresh
// action — all of which go through `tryRefreshUpstreamTokens`) and the
// connect-time reload from the database. Tokens written to the database by
// anything else, such as completing the authorization flow again, are picked
// up the first time the old token is rejected.
//
// In-process only, like the refresh mutex; the database remains the record.
// Kept free of imports so it can be used from tests without opening the
// database.

const currentAccessTokens = new Map<string, string>();

export function setCurrentAccessToken(
  serverUuid: string,
  accessToken: string,
): void {
  currentAccessTokens.set(serverUuid, accessToken);
}

export function getCurrentAccessToken(serverUuid: string): string | undefined {
  return currentAccessTokens.get(serverUuid);
}

/** Exposed for tests; production code has no reason to forget a token. */
export function clearCurrentAccessTokens(): void {
  currentAccessTokens.clear();
}
