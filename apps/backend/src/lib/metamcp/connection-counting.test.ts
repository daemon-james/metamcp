import { describe, expect, it } from "vitest";

import { ConnectedClient } from "./client";
import {
  countConnectionsForServer,
  countTotalConnections,
} from "./connection-counting";

// A ConnectedClient is only ever compared by object identity here, so a bare
// object cast is enough to stand in for a real transport.
const conn = (label: string) => ({ label }) as unknown as ConnectedClient;

describe("connection counting", () => {
  it("counts one shared client once, however many sessions hold it", () => {
    // The exact shape the per-server cap produces: getSession() hands the SAME
    // ConnectedClient to every session past the cap ("Reusing existing
    // connection for server X"). Production hit 137 references to one server
    // against a cap of 5, then refused every new connection pool-wide.
    const shared = conn("shared");
    const activeSessions: Record<string, Record<string, ConnectedClient>> = {};
    for (let i = 0; i < 137; i++) {
      activeSessions[`session-${i}`] = { "server-a": shared };
    }

    expect(
      countConnectionsForServer({
        activeSessions,
        idleSessions: {},
        creatingIdleSessions: new Set(),
        serverUuid: "server-a",
      }),
    ).toBe(1);
  });

  it("counts genuinely distinct connections to one server separately", () => {
    const activeSessions = {
      "session-1": { "server-a": conn("c1") },
      "session-2": { "server-a": conn("c2") },
    };

    expect(
      countConnectionsForServer({
        activeSessions,
        idleSessions: {},
        creatingIdleSessions: new Set(),
        serverUuid: "server-a",
      }),
    ).toBe(2);
  });

  it("does not double-count a client that is both idle and active", () => {
    const client = conn("c1");

    expect(
      countConnectionsForServer({
        activeSessions: { "session-1": { "server-a": client } },
        idleSessions: { "server-a": client },
        creatingIdleSessions: new Set(),
        serverUuid: "server-a",
      }),
    ).toBe(1);
  });

  it("counts a pending idle creation as one connection", () => {
    expect(
      countConnectionsForServer({
        activeSessions: {},
        idleSessions: {},
        creatingIdleSessions: new Set(["server-a"]),
        serverUuid: "server-a",
      }),
    ).toBe(1);
  });

  it("totals distinct connections across servers, not session references", () => {
    // Two backends, one connection each, shared by 50 sessions. The pool holds
    // 2 upstream connections; reference counting would report 100 and trip a
    // cap of 100 with no real connections to reclaim.
    const a = conn("a");
    const b = conn("b");
    const activeSessions: Record<string, Record<string, ConnectedClient>> = {};
    for (let i = 0; i < 50; i++) {
      activeSessions[`session-${i}`] = { "server-a": a, "server-b": b };
    }

    expect(
      countTotalConnections({
        activeSessions,
        idleSessions: {},
        creatingIdleSessions: new Set(),
      }),
    ).toBe(2);
  });

  it("includes idle and pending connections in the total", () => {
    expect(
      countTotalConnections({
        activeSessions: { "session-1": { "server-a": conn("a") } },
        idleSessions: { "server-b": conn("b") },
        creatingIdleSessions: new Set(["server-c"]),
      }),
    ).toBe(3);
  });
});
