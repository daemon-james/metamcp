import { describe, expect, it } from "vitest";

import {
  describeTerminalConnectionError,
  isTerminalConnectionError,
  isUnsupportedProtocolVersionError,
} from "./connection-errors";

describe("isUnsupportedProtocolVersionError", () => {
  // Verbatim shape thrown by the SDK's Client.connect during initialize.
  it("recognises the SDK's version-mismatch error", () => {
    expect(
      isUnsupportedProtocolVersionError(
        new Error("Server's protocol version is not supported: 2027-01-01"),
      ),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isUnsupportedProtocolVersionError(
        new Error("PROTOCOL VERSION IS NOT SUPPORTED"),
      ),
    ).toBe(true);
  });

  it("leaves transient failures alone", () => {
    for (const message of [
      "ECONNREFUSED",
      "fetch failed",
      "Streamable HTTP error: Error POSTing to endpoint: {}",
      "Session not found",
    ]) {
      expect(isUnsupportedProtocolVersionError(new Error(message))).toBe(false);
    }
  });

  it("ignores non-errors", () => {
    expect(
      isUnsupportedProtocolVersionError("protocol version is not supported"),
    ).toBe(false);
    expect(isUnsupportedProtocolVersionError(null)).toBe(false);
  });
});

describe("describeTerminalConnectionError", () => {
  it("names the incompatibility rather than saying the connection failed", () => {
    const description = describeTerminalConnectionError(
      new Error("Server's protocol version is not supported: 2027-01-01"),
    );
    expect(description).toContain("incompatible MCP protocol version");
    expect(description).toContain("2027-01-01");
  });

  it("falls back to the message for anything else", () => {
    expect(describeTerminalConnectionError(new Error("boom"))).toBe("boom");
    expect(describeTerminalConnectionError(42)).toBe("unknown error");
  });
});

describe("isTerminalConnectionError", () => {
  it("only a version mismatch is terminal today", () => {
    expect(
      isTerminalConnectionError(new Error("protocol version is not supported")),
    ).toBe(true);
    expect(isTerminalConnectionError(new Error("ECONNREFUSED"))).toBe(false);
  });
});
