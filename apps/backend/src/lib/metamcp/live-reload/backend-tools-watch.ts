// Notices when a backend starts serving a different tool list.
//
// A deploy swaps a STDIO server's build and kills its processes; the pool
// respawns them from the new build with no database change at all. The only
// place the difference shows is the backend's own tools/list, so the last list
// seen from each server is kept as a hash and compared whenever a list is seen
// again: on every new connection, when a backend sends list_changed, and on
// every namespace tools/list fan-out.
//
// The hash covers the full definitions (name, description, schemas,
// annotations), not just the names, so a changed description or schema counts.
// The first list seen for a server is the baseline and is not a change.

import { createHash } from "node:crypto";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export function hashToolList(tools: Tool[]): string {
  const sorted = [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export class BackendToolsWatch {
  private readonly hashes = new Map<string, string>();

  /**
   * Record the tool list just seen from a server.
   * Returns true when it differs from the last list seen from that server.
   */
  observe(serverUuid: string, tools: Tool[]): boolean {
    const hash = hashToolList(tools);
    const previous = this.hashes.get(serverUuid);
    this.hashes.set(serverUuid, hash);
    return previous !== undefined && previous !== hash;
  }
}
