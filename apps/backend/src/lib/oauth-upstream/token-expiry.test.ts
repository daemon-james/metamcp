import { describe, expect, it } from "vitest";

import { checkTokenExpiry, DEFAULT_REFRESH_SKEW_SECONDS } from "./token-expiry";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000);

describe("checkTokenExpiry", () => {
  it("computes the expiry from tokens_issued_at plus expires_in", () => {
    const { expiresAt } = checkTokenExpiry(
      { tokens: { expires_in: 3600 }, tokens_issued_at: minutesBefore(10) },
      DEFAULT_REFRESH_SKEW_SECONDS,
      NOW,
    );
    expect(expiresAt?.toISOString()).toBe("2026-08-12T12:50:00.000Z");
  });

  it("leaves a token with plenty of life alone", () => {
    const { shouldRefresh } = checkTokenExpiry(
      { tokens: { expires_in: 3600 }, tokens_issued_at: minutesBefore(10) },
      DEFAULT_REFRESH_SKEW_SECONDS,
      NOW,
    );
    expect(shouldRefresh).toBe(false);
  });

  it("refreshes once the remaining life drops inside the skew", () => {
    // Issued 56 minutes ago on a 60-minute token: 4 minutes left, skew is 5.
    const { shouldRefresh } = checkTokenExpiry(
      { tokens: { expires_in: 3600 }, tokens_issued_at: minutesBefore(56) },
      DEFAULT_REFRESH_SKEW_SECONDS,
      NOW,
    );
    expect(shouldRefresh).toBe(true);
  });

  it("refreshes a token that already expired", () => {
    const { shouldRefresh } = checkTokenExpiry(
      { tokens: { expires_in: 3600 }, tokens_issued_at: minutesBefore(120) },
      DEFAULT_REFRESH_SKEW_SECONDS,
      NOW,
    );
    expect(shouldRefresh).toBe(true);
  });

  it("treats the skew boundary as due", () => {
    const { shouldRefresh } = checkTokenExpiry(
      { tokens: { expires_in: 3600 }, tokens_issued_at: minutesBefore(55) },
      DEFAULT_REFRESH_SKEW_SECONDS,
      NOW,
    );
    expect(shouldRefresh).toBe(true);
  });

  it("accepts an ISO string for tokens_issued_at (raw driver rows)", () => {
    const { shouldRefresh } = checkTokenExpiry(
      {
        tokens: { expires_in: 3600 },
        tokens_issued_at: minutesBefore(59).toISOString(),
      },
      DEFAULT_REFRESH_SKEW_SECONDS,
      NOW,
    );
    expect(shouldRefresh).toBe(true);
  });

  // Guessing an expiry from incomplete data would burn rotating refresh
  // tokens on a schedule invented from nothing. refresh-on-401 still covers
  // every case below reactively.
  it("does not refresh when the provider omitted expires_in", () => {
    const result = checkTokenExpiry(
      { tokens: {}, tokens_issued_at: minutesBefore(600) },
      DEFAULT_REFRESH_SKEW_SECONDS,
      NOW,
    );
    expect(result).toEqual({ expiresAt: null, shouldRefresh: false });
  });

  it("does not refresh when tokens_issued_at is unset (pre-migration row)", () => {
    const result = checkTokenExpiry(
      { tokens: { expires_in: 3600 }, tokens_issued_at: null },
      DEFAULT_REFRESH_SKEW_SECONDS,
      NOW,
    );
    expect(result).toEqual({ expiresAt: null, shouldRefresh: false });
  });

  it("does not refresh when there is no session or no tokens", () => {
    expect(checkTokenExpiry(null, DEFAULT_REFRESH_SKEW_SECONDS, NOW)).toEqual({
      expiresAt: null,
      shouldRefresh: false,
    });
    expect(
      checkTokenExpiry(
        { tokens: null, tokens_issued_at: minutesBefore(1) },
        DEFAULT_REFRESH_SKEW_SECONDS,
        NOW,
      ),
    ).toEqual({ expiresAt: null, shouldRefresh: false });
  });

  it("does not refresh on an unparseable timestamp", () => {
    const result = checkTokenExpiry(
      { tokens: { expires_in: 3600 }, tokens_issued_at: "not a date" },
      DEFAULT_REFRESH_SKEW_SECONDS,
      NOW,
    );
    expect(result).toEqual({ expiresAt: null, shouldRefresh: false });
  });

  it("honours a caller-supplied skew", () => {
    const session = {
      tokens: { expires_in: 3600 },
      tokens_issued_at: minutesBefore(30),
    };
    // 30 minutes left: outside a 5-minute skew, inside a 45-minute one.
    expect(checkTokenExpiry(session, 300, NOW).shouldRefresh).toBe(false);
    expect(checkTokenExpiry(session, 2700, NOW).shouldRefresh).toBe(true);
  });

  // A 30-day refresh-issued token (what Sentry returns from the refresh
  // grant) must not be treated as due the moment it lands.
  it("leaves a long-lived token alone", () => {
    const { shouldRefresh } = checkTokenExpiry(
      { tokens: { expires_in: 2_585_626 }, tokens_issued_at: minutesBefore(1) },
      DEFAULT_REFRESH_SKEW_SECONDS,
      NOW,
    );
    expect(shouldRefresh).toBe(false);
  });
});
