import { describe, expect, it } from "vitest";

import { ConfigSnapshot, diffConfigSnapshots } from "./config-snapshot";

const NS = "ns-workstation";
const OTHER_NS = "ns-other";

// Small builder: servers as uuid -> [connection, row], namespaces as
// uuid -> { servers: uuid -> status, toolMappings }.
function snapshot(
  servers: Record<string, [string, string]>,
  namespaces: Record<
    string,
    { servers: Record<string, string>; toolMappings?: string }
  >,
): ConfigSnapshot {
  return {
    servers: new Map(
      Object.entries(servers).map(([uuid, [connection, row]]) => [
        uuid,
        { connection, row },
      ]),
    ),
    namespaces: new Map(
      Object.entries(namespaces).map(([uuid, ns]) => [
        uuid,
        {
          servers: new Map(Object.entries(ns.servers)),
          toolMappings: ns.toolMappings ?? "",
        },
      ]),
    ),
  };
}

function namespaceOf(snap: ConfigSnapshot, uuid: string) {
  const found = snap.namespaces.get(uuid);
  if (!found) throw new Error(`no namespace ${uuid} in snapshot`);
  return found;
}

const base = () =>
  snapshot(
    { chatwoot: ["c1", "r1"], postmark: ["p1", "q1"], unmapped: ["u1", "v1"] },
    {
      [NS]: {
        servers: { chatwoot: "ACTIVE", postmark: "ACTIVE" },
        toolMappings: "t1",
      },
      [OTHER_NS]: { servers: { postmark: "ACTIVE" } },
    },
  );

describe("diffConfigSnapshots", () => {
  it("reports nothing when nothing changed", () => {
    expect(diffConfigSnapshots(base(), base())).toEqual({
      retireServers: [],
      namespaces: [],
    });
  });

  it("a server inserted and mapped into a namespace changes that namespace only", () => {
    const next = base();
    next.servers.set("jdc", { connection: "j1", row: "k1" });
    namespaceOf(next, NS).servers.set("jdc", "ACTIVE");

    expect(diffConfigSnapshots(base(), next)).toEqual({
      retireServers: [],
      namespaces: [NS],
    });
  });

  it("a server inserted but not mapped anywhere changes nothing", () => {
    const next = base();
    next.servers.set("jdc", { connection: "j1", row: "k1" });
    expect(diffConfigSnapshots(base(), next)).toEqual({
      retireServers: [],
      namespaces: [],
    });
  });

  it("a renamed server (row changed, connection not) changes its namespaces without retiring it", () => {
    const next = base();
    next.servers.set("postmark", { connection: "p1", row: "q2" });

    const changes = diffConfigSnapshots(base(), next);
    expect(changes.retireServers).toEqual([]);
    expect(changes.namespaces.sort()).toEqual([NS, OTHER_NS].sort());
  });

  it("changed connection settings retire the server's connections and change its namespaces", () => {
    const next = base();
    next.servers.set("chatwoot", { connection: "c2", row: "r2" });

    expect(diffConfigSnapshots(base(), next)).toEqual({
      retireServers: ["chatwoot"],
      namespaces: [NS],
    });
  });

  it("a deleted server is retired and its former namespaces change", () => {
    // ON DELETE CASCADE removes its mappings in the same statement.
    const next = base();
    next.servers.delete("chatwoot");
    namespaceOf(next, NS).servers.delete("chatwoot");

    expect(diffConfigSnapshots(base(), next)).toEqual({
      retireServers: ["chatwoot"],
      namespaces: [NS],
    });
  });

  it("an unmapped server changes the namespace it left", () => {
    const next = base();
    namespaceOf(next, OTHER_NS).servers.delete("postmark");

    expect(diffConfigSnapshots(base(), next)).toEqual({
      retireServers: [],
      namespaces: [OTHER_NS],
    });
  });

  it("a mapping set INACTIVE changes the namespace", () => {
    const next = base();
    namespaceOf(next, NS).servers.set("chatwoot", "INACTIVE");

    expect(diffConfigSnapshots(base(), next).namespaces).toEqual([NS]);
  });

  it("a tool override or tool status change changes the namespace", () => {
    const next = base();
    namespaceOf(next, NS).toolMappings = "t2";

    expect(diffConfigSnapshots(base(), next)).toEqual({
      retireServers: [],
      namespaces: [NS],
    });
  });

  it("a namespace whose last mapping went away still counts as changed", () => {
    const next = base();
    next.namespaces.delete(OTHER_NS);

    expect(diffConfigSnapshots(base(), next).namespaces).toEqual([OTHER_NS]);
  });

  it("error_status flipping (row only) changes namespaces without retiring", () => {
    const next = base();
    next.servers.set("chatwoot", { connection: "c1", row: "r1-error" });

    expect(diffConfigSnapshots(base(), next)).toEqual({
      retireServers: [],
      namespaces: [NS],
    });
  });
});
