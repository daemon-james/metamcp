// Notices when a backend starts serving a different tool list.
//
// A deploy swaps a STDIO server's build and kills its processes; the pool
// respawns them from the new build with no database change at all. The only
// place the difference shows is the backend's own tools/list.
//
// Lists are compared per connection, never across connections. The pool keeps
// several connections to one server, and they can legitimately serve different
// lists: `uvx pkg@latest` starts each process on whatever was newest at the
// time, and some remote servers vary by connection (Stripe sent 11 or 12
// tools). Comparing each list with the last one from *any* connection made
// the hash flip between connections and announced a change on every listing,
// about 21,000 times between 24 Oct and 7 Nov 2026.
//
// So a list counts as a change only when:
//   - a connection that already served a list now serves a different one
//     (the backend sent list_changed), or
//   - a new connection serves a list that no live connection of that server
//     serves, and either other connections are live or an earlier list was
//     seen (a respawn after the old processes are gone).
// The first list ever seen for a server is the baseline and is not a change.
//
// The hash covers the full definitions (name, description, schemas,
// annotations), with object keys sorted so key order does not count.

import { createHash } from "node:crypto";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

export function hashToolList(tools: Tool[]): string {
  const sorted = [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical(sorted)))
    .digest("hex");
}

export class BackendToolsWatch<Connection extends object = object> {
  /** Live connections per server, with the hash each one last served. */
  private readonly live = new Map<string, Map<Connection, string>>();
  /** The last hash seen from each server, kept after its connections close. */
  private readonly last = new Map<string, string>();

  /**
   * Record the tool list just seen on one connection to a server.
   * Returns true when it is a change (see the rules above).
   */
  observe(serverUuid: string, connection: Connection, tools: Tool[]): boolean {
    const hash = hashToolList(tools);
    let connections = this.live.get(serverUuid);
    if (!connections) {
      connections = new Map();
      this.live.set(serverUuid, connections);
    }

    const own = connections.get(connection);
    let changed: boolean;
    if (own !== undefined) {
      changed = own !== hash;
    } else if (connections.size > 0) {
      changed = ![...connections.values()].includes(hash);
    } else {
      const previous = this.last.get(serverUuid);
      changed = previous !== undefined && previous !== hash;
    }

    connections.set(connection, hash);
    this.last.set(serverUuid, hash);
    return changed;
  }

  /** The connection closed; its list no longer counts. */
  forget(serverUuid: string, connection: Connection): void {
    const connections = this.live.get(serverUuid);
    if (!connections) return;
    connections.delete(connection);
    if (connections.size === 0) this.live.delete(serverUuid);
  }
}
