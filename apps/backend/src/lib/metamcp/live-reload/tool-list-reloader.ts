// Brings every connected client session up to date when its namespace's tool
// list changes.
//
// tools/list is answered live (from the database and the backends) on every
// call, so the list a client is given is never stale; the list a client is
// *holding* is. MCP's answer is `notifications/tools/list_changed`, which
// tells the client to fetch the list again. It travels on the session's
// server-to-client stream: the GET stream for streamable HTTP, the event
// stream for SSE.
//
// So every session of the namespace is sent list_changed. A session with no
// open stream cannot receive it (the SDK transport drops it silently), so it
// is marked as having missed it and is sent it again when its stream comes
// back. Until then it keeps the list it has.
//
// A session is never ended because its tool list changed. That used to happen
// to sessions that could not be told, and it cut agents off mid-task: Cursor's
// CLI does not recover from the 404 at all, and Codex re-initialises but keeps
// its old list. A stale tool list costs much less than a dropped agent.
//
// Bursts are coalesced: a deploy rewrites rows and respawns processes within
// seconds, and each signal restarts a short quiet-period timer so clients are
// told once, after things settle. `maxDelayMs` bounds that so a steady trickle
// of changes cannot postpone the notification indefinitely.
//
// Free of database and pool imports so it can be unit-tested directly; the
// wiring lives in live-reload.ts.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import logger from "@/utils/logger";

export interface ToolListReloaderOptions {
  /** Quiet period after the last change signal before clients are told. */
  debounceMs: number;
  /** Longest a namespace's notification may be postponed by further signals. */
  maxDelayMs: number;
  /** Runs before a namespace's sessions are notified (cache invalidation). */
  beforeNotify?: (namespaceUuid: string) => void;
}

interface TrackedSession {
  namespaceUuid: string;
  transport: Transport;
  /** It could not be told about a change and has not listed tools since. */
  missed: boolean;
}

interface PendingChange {
  timer: NodeJS.Timeout;
  firstSignalAt: number;
  reasons: Set<string>;
}

const TOOL_LIST_CHANGED: JSONRPCMessage = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
};

export class ToolListReloader {
  private readonly sessions = new Map<string, TrackedSession>();
  /**
   * Open server-to-client streams per session. A count, not a flag: a second
   * GET is refused with 409 and closes while the first is still open.
   */
  private readonly openStreams = new Map<string, number>();
  private readonly pending = new Map<string, PendingChange>();

  constructor(private readonly options: ToolListReloaderOptions) {}

  /**
   * Start tracking a client session. Call once the server is connected to the
   * transport; wraps the transport's message hook to see tools/list calls.
   */
  attach(
    sessionId: string,
    namespaceUuid: string,
    transport: Transport,
    { streamOpen = false }: { streamOpen?: boolean } = {},
  ): void {
    if (streamOpen) this.streamOpened(sessionId);
    const session: TrackedSession = { namespaceUuid, transport, missed: false };
    this.sessions.set(sessionId, session);

    const deliver = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ("method" in message && "id" in message) {
        if (message.method === "tools/list") session.missed = false;
      }
      deliver?.(message, extra);
    };
  }

  /** Stop tracking a session (it was closed, deleted or expired). */
  detach(sessionId: string): void {
    this.openStreams.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  /**
   * The session's server-to-client stream opened. May be called before
   * `attach`. A notification the session missed is sent again now.
   */
  streamOpened(sessionId: string): void {
    this.openStreams.set(sessionId, (this.openStreams.get(sessionId) ?? 0) + 1);
    const session = this.sessions.get(sessionId);
    if (!session?.missed) return;
    session.missed = false;
    this.send(sessionId, session);
  }

  /** The session's server-to-client stream closed. */
  streamClosed(sessionId: string): void {
    const open = (this.openStreams.get(sessionId) ?? 0) - 1;
    if (open > 0) this.openStreams.set(sessionId, open);
    else this.openStreams.delete(sessionId);
  }

  /**
   * Something that affects this namespace's tool list changed. Clients are
   * told after `debounceMs` without further signals, or `maxDelayMs` after
   * the first, whichever comes first.
   */
  changed(namespaceUuid: string, reason: string): void {
    const now = Date.now();
    const existing = this.pending.get(namespaceUuid);
    if (existing) clearTimeout(existing.timer);

    const firstSignalAt = existing?.firstSignalAt ?? now;
    const reasons = existing?.reasons ?? new Set<string>();
    reasons.add(reason);

    const delay = Math.max(
      0,
      Math.min(
        this.options.debounceMs,
        firstSignalAt + this.options.maxDelayMs - now,
      ),
    );
    const timer = setTimeout(() => {
      this.pending.delete(namespaceUuid);
      this.notifyNamespace(namespaceUuid, [...reasons].join("; "));
    }, delay);
    timer.unref?.();
    this.pending.set(namespaceUuid, { timer, firstSignalAt, reasons });
  }

  /**
   * Tell the namespace's sessions now, without waiting for the quiet period.
   * Any change already waiting for this namespace is folded in.
   * Returns the number of sessions notified.
   */
  reloadNow(namespaceUuid: string, reason: string): number {
    const existing = this.pending.get(namespaceUuid);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(namespaceUuid);
      existing.reasons.add(reason);
      reason = [...existing.reasons].join("; ");
    }
    return this.notifyNamespace(namespaceUuid, reason);
  }

  /** Number of tracked sessions per namespace, for diagnostics. */
  sessionCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { namespaceUuid } of this.sessions.values()) {
      counts[namespaceUuid] = (counts[namespaceUuid] ?? 0) + 1;
    }
    return counts;
  }

  private notifyNamespace(namespaceUuid: string, reason: string): number {
    try {
      this.options.beforeNotify?.(namespaceUuid);
    } catch (error) {
      logger.error(
        `Tool list reload: cache invalidation failed for namespace ${namespaceUuid}:`,
        error,
      );
    }

    let notified = 0;
    let unreachable = 0;
    for (const [sessionId, session] of this.sessions) {
      if (session.namespaceUuid !== namespaceUuid) continue;
      notified += 1;
      this.send(sessionId, session);
      // Without an open stream the send goes nowhere; it is sent again when
      // the stream comes back, and until then the session keeps its list.
      session.missed = !this.openStreams.has(sessionId);
      if (session.missed) unreachable += 1;
    }

    logger.info(
      `Tool list changed for namespace ${namespaceUuid} (${reason}); notified ${notified} session(s), ${unreachable} without an open stream`,
    );
    return notified;
  }

  private send(sessionId: string, session: TrackedSession): void {
    session.transport.send(TOOL_LIST_CHANGED).catch((error) => {
      logger.warn(
        `Tool list reload: could not send list_changed to session ${sessionId}:`,
        error,
      );
    });
  }
}
