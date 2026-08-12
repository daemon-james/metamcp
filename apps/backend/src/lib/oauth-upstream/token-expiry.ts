// Pure expiry arithmetic for upstream OAuth tokens.
//
// Deliberately free of database and logger imports so it can be unit-tested
// without a live connection — importing `refresh-on-401.ts` pulls in the
// repositories, which open the pool at import time.

// Refresh a token slightly before it expires rather than after the upstream
// has already rejected it.
//
// Reacting to a 401 recovers, but only once something has already failed:
// between the moment the access_token dies and the moment anything notices,
// every tool call routed to that server errors. Access-token lifetimes of an
// hour are common (Sentry and Stripe both issue exactly that), so at the
// default 60-second health-check cadence there is a window like that once per
// hour, per server. Renewing ahead of expiry removes it.
export const DEFAULT_REFRESH_SKEW_SECONDS = 300;

export interface ExpiryCheck {
  expiresAt: Date | null;
  shouldRefresh: boolean;
}

export interface ExpiryCheckInput {
  tokens?: { expires_in?: number } | null;
  tokens_issued_at?: Date | string | null;
}

// A token is due for renewal when its remaining life is under the skew.
//
// `issuedAt` must come from `oauth_sessions.tokens_issued_at`, not
// `updated_at`: the latter also moves for code_verifier and expected_state
// writes, which would make a token look younger than it is and suppress the
// refresh that this whole mechanism exists to perform.
//
// Both unknowns are deliberately treated as "not due". A missing `expires_in`
// means the provider never told us the lifetime — RFC 6749 makes the field
// OPTIONAL — and a missing `tokens_issued_at` means the row predates the
// column. Guessing an expiry in either case would burn rotating refresh
// tokens on a schedule invented from nothing; refresh-on-401 still covers
// those servers reactively.
export function checkTokenExpiry(
  session: ExpiryCheckInput | null | undefined,
  skewSeconds: number = DEFAULT_REFRESH_SKEW_SECONDS,
  now: Date = new Date(),
): ExpiryCheck {
  const expiresIn = session?.tokens?.expires_in;
  const issuedAt = session?.tokens_issued_at;
  if (!session?.tokens || typeof expiresIn !== "number" || !issuedAt) {
    return { expiresAt: null, shouldRefresh: false };
  }

  const issued = issuedAt instanceof Date ? issuedAt : new Date(issuedAt);
  if (Number.isNaN(issued.getTime())) {
    return { expiresAt: null, shouldRefresh: false };
  }

  const expiresAt = new Date(issued.getTime() + expiresIn * 1000);
  const remainingSeconds = (expiresAt.getTime() - now.getTime()) / 1000;
  return { expiresAt, shouldRefresh: remainingSeconds <= skewSeconds };
}
