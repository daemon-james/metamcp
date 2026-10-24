// What, in the database, decides a namespace's tool list — reduced to
// fingerprints so two readings can be compared.
//
// Agents and deploy scripts edit `mcp_servers` and the mapping tables with
// direct SQL as often as through the UI, so changes are found by reading the
// tables rather than by hooking the code paths that write them. The reading is
// a few small queries every few seconds (see live-reload.ts); this file holds
// the pure part: the snapshot shape and the comparison.

export interface ServerFingerprint {
  /** Everything used to connect: type, command, args, env, url, headers... */
  connection: string;
  /** The whole row: also the name (the tool prefix) and error_status. */
  row: string;
}

export interface NamespaceFingerprint {
  /** mcp_server_uuid -> mapping status (ACTIVE / INACTIVE). */
  servers: Map<string, string>;
  /** Fingerprint of the namespace's tool mappings (status and overrides). */
  toolMappings: string;
}

export interface ConfigSnapshot {
  servers: Map<string, ServerFingerprint>;
  namespaces: Map<string, NamespaceFingerprint>;
}

export interface ConfigChanges {
  /**
   * Servers whose connection settings changed or that were deleted. Their
   * pooled connections were built from the old settings and must be retired;
   * the pool reconnects from the database on next use.
   */
  retireServers: string[];
  /** Namespaces whose clients must re-fetch their tool list. */
  namespaces: string[];
}

function namespacesContaining(
  snapshot: ConfigSnapshot,
  serverUuid: string,
): string[] {
  const found: string[] = [];
  for (const [namespaceUuid, namespace] of snapshot.namespaces) {
    if (namespace.servers.has(serverUuid)) found.push(namespaceUuid);
  }
  return found;
}

function sameNamespace(
  a: NamespaceFingerprint | undefined,
  b: NamespaceFingerprint | undefined,
): boolean {
  if (!a || !b) return a === b;
  if (a.toolMappings !== b.toolMappings) return false;
  if (a.servers.size !== b.servers.size) return false;
  for (const [serverUuid, status] of a.servers) {
    if (b.servers.get(serverUuid) !== status) return false;
  }
  return true;
}

export function diffConfigSnapshots(
  previous: ConfigSnapshot,
  next: ConfigSnapshot,
): ConfigChanges {
  const retireServers = new Set<string>();
  const namespaces = new Set<string>();

  const serverUuids = new Set([
    ...previous.servers.keys(),
    ...next.servers.keys(),
  ]);
  for (const serverUuid of serverUuids) {
    const before = previous.servers.get(serverUuid);
    const after = next.servers.get(serverUuid);
    if (before?.row === after?.row) continue;

    if (before && (!after || before.connection !== after.connection)) {
      retireServers.add(serverUuid);
    }
    for (const namespaceUuid of [
      ...namespacesContaining(previous, serverUuid),
      ...namespacesContaining(next, serverUuid),
    ]) {
      namespaces.add(namespaceUuid);
    }
  }

  const namespaceUuids = new Set([
    ...previous.namespaces.keys(),
    ...next.namespaces.keys(),
  ]);
  for (const namespaceUuid of namespaceUuids) {
    if (
      !sameNamespace(
        previous.namespaces.get(namespaceUuid),
        next.namespaces.get(namespaceUuid),
      )
    ) {
      namespaces.add(namespaceUuid);
    }
  }

  return {
    retireServers: [...retireServers],
    namespaces: [...namespaces],
  };
}
