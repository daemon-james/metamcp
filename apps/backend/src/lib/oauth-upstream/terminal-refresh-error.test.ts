import { beforeEach, describe, expect, it } from "vitest";

import {
  clearDeadRefreshToken,
  isRefreshTokenKnownDead,
  isTerminalRefreshError,
  markRefreshTokenDead,
} from "./terminal-refresh-error";

describe("isTerminalRefreshError", () => {
  it("treats invalid_grant as terminal", () => {
    // Stripe, observed 2026-08-22/23: 976 identical invalid_grant failures in
    // 12h, one per 60s sweep, because nothing classified the error as final.
    expect(isTerminalRefreshError({ oauthError: "invalid_grant", status: 400 }))
      .toBe(true);
  });

  it.each(["invalid_client", "unauthorized_client", "unsupported_grant_type"])(
    "treats %s as terminal",
    (oauthError) => {
      expect(isTerminalRefreshError({ oauthError, status: 400 })).toBe(true);
    },
  );

  it.each(["server_error", "temporarily_unavailable"])(
    "treats %s as retryable",
    (oauthError) => {
      expect(isTerminalRefreshError({ oauthError, status: 503 })).toBe(false);
    },
  );

  it("treats 5xx without an OAuth error code as retryable", () => {
    expect(isTerminalRefreshError({ oauthError: undefined, status: 502 })).toBe(
      false,
    );
  });

  it("treats an unknown error code as retryable rather than giving up", () => {
    expect(
      isTerminalRefreshError({ oauthError: "wat_is_this", status: 400 }),
    ).toBe(false);
  });
});

describe("dead refresh token registry", () => {
  beforeEach(() => {
    clearDeadRefreshToken("server-a");
    clearDeadRefreshToken("server-b");
  });

  it("suppresses the exact token that failed terminally", () => {
    markRefreshTokenDead("server-a", "rt-dead");
    expect(isRefreshTokenKnownDead("server-a", "rt-dead")).toBe(true);
  });

  it("lets a re-authorized token through without any explicit reset", () => {
    // Re-auth writes a different refresh_token, so keying the block on the
    // token value means the operator never has to clear anything by hand.
    markRefreshTokenDead("server-a", "rt-dead");
    expect(isRefreshTokenKnownDead("server-a", "rt-fresh")).toBe(false);
  });

  it("scopes the block to one server", () => {
    markRefreshTokenDead("server-a", "rt-shared");
    expect(isRefreshTokenKnownDead("server-b", "rt-shared")).toBe(false);
  });

  it("forgets the block once cleared", () => {
    markRefreshTokenDead("server-a", "rt-dead");
    clearDeadRefreshToken("server-a");
    expect(isRefreshTokenKnownDead("server-a", "rt-dead")).toBe(false);
  });
});
