import { ConnectedClient } from "./client";

export interface SharedConnectionQuery {
  /** The pool's `activeSessions` map: sessionId -> serverUuid -> client. */
  activeSessions: Record<string, Record<string, ConnectedClient>>;
  /** The session being torn down / whose slot is being released. */
  sessionId: string;
  /** The backend server whose slot is being released. */
  serverUuid: string;
  /** The client object cached in that slot. */
  client: ConnectedClient;
}

/**
 * Is this ConnectedClient still reachable from a session other than the one
 * releasing it?
 *
 * MetaMCP caps upstream connections per backend server
 * (`maxConnectionsPerServer`, default 5). Past that cap `getSession()` does not
 * refuse — it deliberately hands the SAME ConnectedClient to an additional
 * client session ("Reusing existing connection for server X (at per-server cap
 * 5)"). So one transport can back several client sessions at once.
 *
 * `cleanupSession()` used to release each of the expiring session's slots with
 * no regard for that sharing: it either destroyed the client outright, or
 * parked it in the idle pool where the 60s health check owns it. Either way a
 * sibling session that was still pointing at the same object was left holding
 * a torn-down transport, and its next `tools/call` failed with the SDK's bare
 * `Error: Not connected`.
 *
 * Production evidence 2026-08-13: 144 "Reusing existing connection" events in
 * 24h, `2d3c8f30` (mnemonik) reaching 6/5 connections 18 times, and cleanup
 * tallies of `recycled: 0, destroyed: 15` — every one a chance to pull a live
 * transport out from under a working session.
 *
 * Comparison is by object identity, which is exactly what the cap-reuse path
 * creates: the sibling slot holds the very same instance, not a copy. Two
 * distinct connections to one backend are NOT sharing and must still be
 * released normally, or the pool would leak a connection per session.
 */
export function isClientSharedWithOtherSessions({
  activeSessions,
  sessionId,
  serverUuid,
  client,
}: SharedConnectionQuery): boolean {
  for (const [otherSessionId, sessionServers] of Object.entries(
    activeSessions,
  )) {
    if (otherSessionId === sessionId) continue;
    if (sessionServers[serverUuid] === client) {
      return true;
    }
  }
  return false;
}
