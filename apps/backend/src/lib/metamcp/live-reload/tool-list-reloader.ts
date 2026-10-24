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
// gets `refetchWindowMs` for its stream to come back (it is then sent the
// notification again) or for it to call tools/list. If neither happens it is
// ended as soon as it has no request in flight: the next request bearing its
// session id gets HTTP 404, which the spec defines as "start a new session",
// and a new session lists its tools. A session in the middle of a call is
// never ended; it is ended when its last call returns.
//
// A session that has an open stream is never ended, even if it does not
// re-fetch. Verified 2026-10-24: Claude Code re-fetches within milliseconds;
// Codex ignores list_changed unless its `mcp_tool_list_changed` feature is on,
// and after a 404 it re-initialises and retries but keeps its old tool list,
// so ending its session would cost a reconnect and fix nothing; Cursor's CLI
// does not recover from a 404 at all.
//
// Requests are counted at the JSON-RPC level (request in, response out), not
// per HTTP request: the streamable HTTP GET stream stays open for the life of
// the session and is not work in progress, and on the SSE transport a POST
// returns 202 long before the call it carries has finished.
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
  /**
   * How long a session that could not be told (no open stream) has to reopen
   * its stream or call tools/list before it is ended.
   */
  refetchWindowMs: number;
  /** Runs before a namespace's sessions are notified (cache invalidation). */
  beforeNotify?: (namespaceUuid: string) => void;
}

interface TrackedSession {
  namespaceUuid: string;
  transport: Transport;
  end: () => Promise<void>;
  /** JSON-RPC ids of client requests that have not been answered yet. */
  inFlight: Set<string | number>;
  /** Set while the session missed a notification and owes us a tools/list. */
  refetchTimer?: NodeJS.Timeout;
  /** The refetch window has passed; end the session once it is idle. */
  overdue: boolean;
  ending: boolean;
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

const isRequest = (
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: string | number; method: string } =>
  "method" in message && "id" in message;

const isResponse = (
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: string | number } =>
  !("method" in message) && "id" in message;

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
   * transport; wraps the transport's message hooks to see requests, responses
   * and tools/list calls. `end` must make the session id unknown (so its next
   * request gets 404) and close the transport.
   */
  attach(
    sessionId: string,
    namespaceUuid: string,
    transport: Transport,
    end: () => Promise<void>,
    { streamOpen = false }: { streamOpen?: boolean } = {},
  ): void {
    if (streamOpen) this.streamOpened(sessionId);
    const session: TrackedSession = {
      namespaceUuid,
      transport,
      end,
      inFlight: new Set(),
      overdue: false,
      ending: false,
    };
    this.sessions.set(sessionId, session);

    const deliver = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (isRequest(message)) {
        session.inFlight.add(message.id);
        if (message.method === "tools/list") this.toolsListed(session);
      }
      deliver?.(message, extra);
    };

    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      try {
        await send(message, options);
      } finally {
        if (isResponse(message) && session.inFlight.delete(message.id)) {
          this.endIfOverdueAndIdle(sessionId, session);
        }
      }
    };
  }

  /** Stop tracking a session (it was closed, deleted or expired). */
  detach(sessionId: string): void {
    this.openStreams.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.refetchTimer);
    this.sessions.delete(sessionId);
  }

  /**
   * The session's server-to-client stream opened. May be called before
   * `attach`. A notification the session missed is sent again now.
   */
  streamOpened(sessionId: string): void {
    this.openStreams.set(sessionId, (this.openStreams.get(sessionId) ?? 0) + 1);
    const session = this.sessions.get(sessionId);
    if (!session || session.ending) return;
    if (!session.refetchTimer && !session.overdue) return;
    this.clearRefetch(session);
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
      if (session.namespaceUuid !== namespaceUuid || session.ending) continue;
      notified += 1;
      this.send(sessionId, session);
      if (this.openStreams.has(sessionId)) {
        // It will hear about it; whether it acts is up to the client.
        this.clearRefetch(session);
        continue;
      }

      // Nothing can reach this session. A fresh window for every change.
      unreachable += 1;
      clearTimeout(session.refetchTimer);
      session.overdue = false;
      session.refetchTimer = setTimeout(() => {
        session.refetchTimer = undefined;
        session.overdue = true;
        this.endIfOverdueAndIdle(sessionId, session);
      }, this.options.refetchWindowMs);
      session.refetchTimer.unref?.();
    }

    logger.info(
      `Tool list changed for namespace ${namespaceUuid} (${reason}); notified ${notified} session(s), ${unreachable} without an open stream`,
    );
    return notified;
  }

  private send(sessionId: string, session: TrackedSession): void {
    session.transport.send(TOOL_LIST_CHANGED).catch((error) => {
      // Not fatal: a session without a stream is handled by the window.
      logger.warn(
        `Tool list reload: could not send list_changed to session ${sessionId}:`,
        error,
      );
    });
  }

  private toolsListed(session: TrackedSession): void {
    this.clearRefetch(session);
  }

  private clearRefetch(session: TrackedSession): void {
    clearTimeout(session.refetchTimer);
    session.refetchTimer = undefined;
    session.overdue = false;
  }

  private endIfOverdueAndIdle(sessionId: string, session: TrackedSession) {
    if (!session.overdue || session.ending || session.inFlight.size > 0) {
      return;
    }
    session.ending = true;
    // Deferred one tick so a response that has just been handed to the
    // transport is written before the transport closes.
    setTimeout(() => {
      if (session.inFlight.size > 0) {
        // A request arrived in the meantime; its response retries this.
        session.ending = false;
        return;
      }
      logger.info(
        `Tool list reload: ending session ${sessionId} (namespace ${session.namespaceUuid}); it had no open stream to receive list_changed and did not re-fetch tools/list, so its next request gets 404 and it re-initialises`,
      );
      this.detach(sessionId);
      session.end().catch((error) => {
        logger.error(
          `Tool list reload: error ending session ${sessionId}:`,
          error,
        );
      });
    }, 0);
  }
}
