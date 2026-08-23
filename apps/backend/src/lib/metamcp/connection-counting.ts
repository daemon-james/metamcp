import { ConnectedClient } from "./client";

export interface ConnectionCountQuery {
  /** The pool's `activeSessions` map: sessionId -> serverUuid -> client. */
  activeSessions: Record<string, Record<string, ConnectedClient>>;
  /** The pool's `idleSessions` map: serverUuid -> client. */
  idleSessions: Record<string, ConnectedClient>;
  /** Server UUIDs with an idle connection currently being created. */
  creatingIdleSessions: Set<string>;
  /** Active connection attempts in flight for each server UUID. */
  creatingActiveConnections: Map<string, Set<Promise<void>>>;
}

/**
 * How many upstream connections does the pool actually hold?
 *
 * The pool's caps exist to stop it spawning unbounded upstream processes, so
 * they have to be measured in transports. But `activeSessions` is a map of
 * session *references*, and past the per-server cap `getSession()` stores the
 * SAME ConnectedClient under many session IDs on purpose (see
 * `isClientSharedWithOtherSessions`). Summing the map therefore counts one
 * transport once per session holding it.
 *
 * Production evidence 2026-08-23: one backend reported "Per-server connection
 * limit reached: 137/5" and, on the very next line, "Reusing existing
 * connection" — 137 references to a single transport. Pool-wide the same
 * arithmetic reached 458 against a cap of 100, so `canCreateConnection()`
 * refused every new connection. `tools/list` then dropped 12 of 15 backends
 * and served 19 tools instead of 259, and no restart-free path existed back:
 * the count only falls when sessions are reaped, and the references outlive
 * the transports they point at.
 *
 * Deduplicating by object identity is what makes the number mean "connections"
 * again. Two genuinely distinct transports to one backend still count twice.
 */
export function countConnectionsForServer({
  activeSessions,
  idleSessions,
  creatingIdleSessions,
  creatingActiveConnections,
  serverUuid,
}: ConnectionCountQuery & { serverUuid: string }): number {
  const distinct = new Set<ConnectedClient>();

  const idle = idleSessions[serverUuid];
  if (idle) {
    distinct.add(idle);
  }

  for (const sessionServers of Object.values(activeSessions)) {
    const client = sessionServers[serverUuid];
    if (client) {
      distinct.add(client);
    }
  }

  // A pending creation has no client object yet, so it can't be deduplicated.
  // Reserve a slot for each attempt so concurrent callers cannot race past the
  // cap before their clients enter activeSessions.
  return (
    distinct.size +
    (creatingIdleSessions.has(serverUuid) ? 1 : 0) +
    (creatingActiveConnections.get(serverUuid)?.size ?? 0)
  );
}

/**
 * Total distinct upstream connections across every backend, idle and active,
 * plus connection attempts still in flight. Same identity rule as
 * `countConnectionsForServer`.
 */
export function countTotalConnections({
  activeSessions,
  idleSessions,
  creatingIdleSessions,
  creatingActiveConnections,
}: ConnectionCountQuery): number {
  const distinct = new Set<ConnectedClient>();

  for (const client of Object.values(idleSessions)) {
    distinct.add(client);
  }

  for (const sessionServers of Object.values(activeSessions)) {
    for (const client of Object.values(sessionServers)) {
      distinct.add(client);
    }
  }

  let activeAttempts = 0;
  for (const attempts of creatingActiveConnections.values()) {
    activeAttempts += attempts.size;
  }

  return distinct.size + creatingIdleSessions.size + activeAttempts;
}
