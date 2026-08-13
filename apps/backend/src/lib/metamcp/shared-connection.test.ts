import { describe, expect, it } from "vitest";

import { ConnectedClient } from "./client";
import { isClientSharedWithOtherSessions } from "./shared-connection";

// The pool stores ConnectedClient objects by identity; the refcount only ever
// compares references, so a bare object is a sufficient stand-in.
const client = (label: string) => ({ label }) as unknown as ConnectedClient;

describe("isClientSharedWithOtherSessions", () => {
  it("returns false when only the cleaning session holds the client", () => {
    const a = client("a");

    expect(
      isClientSharedWithOtherSessions({
        activeSessions: { sessionA: { serverX: a } },
        sessionId: "sessionA",
        serverUuid: "serverX",
        client: a,
      }),
    ).toBe(false);
  });

  it("returns true when a sibling session holds the same client object", () => {
    // This is the state produced by the per-server connection cap: getSession()
    // hands the SAME ConnectedClient to a second session rather than spawning
    // a sixth connection ("Reusing existing connection ... at per-server cap").
    const shared = client("shared");

    expect(
      isClientSharedWithOtherSessions({
        activeSessions: {
          sessionA: { serverX: shared },
          sessionB: { serverX: shared },
        },
        sessionId: "sessionA",
        serverUuid: "serverX",
        client: shared,
      }),
    ).toBe(true);
  });

  it("returns false when a sibling holds a DIFFERENT client for the same server", () => {
    // Two independent connections to one backend is the normal, un-shared case.
    // Destroying one must not be blocked by the existence of the other.
    const a = client("a");
    const b = client("b");

    expect(
      isClientSharedWithOtherSessions({
        activeSessions: {
          sessionA: { serverX: a },
          sessionB: { serverX: b },
        },
        sessionId: "sessionA",
        serverUuid: "serverX",
        client: a,
      }),
    ).toBe(false);
  });

  it("ignores the same client parked under a different serverUuid", () => {
    const shared = client("shared");

    expect(
      isClientSharedWithOtherSessions({
        activeSessions: {
          sessionA: { serverX: shared },
          sessionB: { serverY: shared },
        },
        sessionId: "sessionA",
        serverUuid: "serverX",
        client: shared,
      }),
    ).toBe(false);
  });

  it("detects sharing across more than one sibling session", () => {
    const shared = client("shared");

    expect(
      isClientSharedWithOtherSessions({
        activeSessions: {
          sessionA: { serverX: shared },
          sessionB: { serverX: shared },
          sessionC: { serverX: shared },
        },
        sessionId: "sessionC",
        serverUuid: "serverX",
        client: shared,
      }),
    ).toBe(true);
  });

  it("returns false for an empty pool", () => {
    expect(
      isClientSharedWithOtherSessions({
        activeSessions: {},
        sessionId: "sessionA",
        serverUuid: "serverX",
        client: client("a"),
      }),
    ).toBe(false);
  });
});
