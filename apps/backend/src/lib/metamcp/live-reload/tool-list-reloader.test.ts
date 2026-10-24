import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolListReloader } from "./tool-list-reloader";

const NS = "namespace-a";
const OTHER_NS = "namespace-b";
const LIST_CHANGED = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
};

// Stands in for a server transport after `server.connect()`: the server has
// set `onmessage`, and everything the server sends lands in `sent`.
class FakeTransport implements Transport {
  sent: JSONRPCMessage[] = [];
  delivered: JSONRPCMessage[] = [];
  failSends = false;
  onmessage?: Transport["onmessage"] = (message) => {
    this.delivered.push(message);
  };
  async start() {}
  async close() {}
  async send(message: JSONRPCMessage) {
    if (this.failSends) throw new Error("no stream");
    this.sent.push(message);
  }

  /** The client sends a request. */
  request(id: number, method: string) {
    this.onmessage?.({ jsonrpc: "2.0", id, method });
  }
  /** The server answers request `id`. */
  respond(id: number) {
    return this.send({ jsonrpc: "2.0", id, result: {} });
  }
  listChangedCount() {
    return this.sent.filter(
      (m) => "method" in m && m.method === LIST_CHANGED.method,
    ).length;
  }
}

describe("ToolListReloader", () => {
  let reloader: ToolListReloader;
  let beforeNotify: ReturnType<typeof vi.fn<(namespaceUuid: string) => void>>;

  const attach = (sessionId: string, namespaceUuid = NS) => {
    const transport = new FakeTransport();
    const end = vi.fn(async () => {});
    reloader.attach(sessionId, namespaceUuid, transport, end);
    return { transport, end };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    beforeNotify = vi.fn<(namespaceUuid: string) => void>();
    reloader = new ToolListReloader({
      debounceMs: 3_000,
      maxDelayMs: 15_000,
      refetchWindowMs: 10_000,
      beforeNotify,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("detection signals", () => {
    it("coalesces a burst of changes into one notification after the quiet period", async () => {
      const a = attach("a");

      reloader.changed(NS, "row edited");
      await vi.advanceTimersByTimeAsync(1_000);
      reloader.changed(NS, "server respawned");
      await vi.advanceTimersByTimeAsync(2_999);
      expect(a.transport.listChangedCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(a.transport.listChangedCount()).toBe(1);
      expect(beforeNotify).toHaveBeenCalledWith(NS);
    });

    it("does not let a steady trickle of changes postpone the notification past maxDelay", async () => {
      const a = attach("a");
      for (let elapsed = 0; elapsed < 15_000; elapsed += 2_000) {
        reloader.changed(NS, "tick");
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(a.transport.listChangedCount()).toBe(1);
    });

    it("only tells sessions of the namespace that changed", async () => {
      const a = attach("a", NS);
      const b = attach("b", OTHER_NS);

      reloader.changed(NS, "row edited");
      await vi.advanceTimersByTimeAsync(3_000);

      expect(a.transport.listChangedCount()).toBe(1);
      expect(b.transport.listChangedCount()).toBe(0);
    });

    it("reloadNow notifies at once, folds in a pending change and reports the count", async () => {
      const a = attach("a");
      attach("b");
      attach("c", OTHER_NS);

      reloader.changed(NS, "row edited");
      expect(reloader.reloadNow(NS, "manual")).toBe(2);
      expect(a.transport.listChangedCount()).toBe(1);

      // The pending debounced change was absorbed, not sent a second time.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(a.transport.listChangedCount()).toBe(1);
    });
  });

  describe("fan-out", () => {
    it("sends list_changed on the session's own transport", () => {
      const a = attach("a");
      reloader.reloadNow(NS, "manual");
      expect(a.transport.sent).toEqual([LIST_CHANGED]);
    });

    it("passes every client message through to the server", () => {
      const a = attach("a");
      a.transport.request(1, "tools/call");
      expect(a.transport.delivered).toEqual([
        { jsonrpc: "2.0", id: 1, method: "tools/call" },
      ]);
    });

    it("keeps a session that re-fetches tools/list within the window", async () => {
      const a = attach("a");
      reloader.reloadNow(NS, "manual");

      a.transport.request(1, "tools/list");
      await a.transport.respond(1);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(a.end).not.toHaveBeenCalled();
    });

    it("does not throw when a session cannot be sent the notification", async () => {
      const a = attach("a");
      a.transport.failSends = true;
      expect(() => reloader.reloadNow(NS, "manual")).not.toThrow();
      // ...and the refetch window still deals with it.
      await vi.advanceTimersByTimeAsync(10_001);
      expect(a.end).toHaveBeenCalledOnce();
    });

    it("forgets a detached session", async () => {
      const a = attach("a");
      reloader.reloadNow(NS, "manual");
      reloader.detach("a");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.end).not.toHaveBeenCalled();
      expect(reloader.reloadNow(NS, "manual")).toBe(0);
    });
  });

  // Sessions in this block have no open stream, so the notification cannot
  // reach them; see "sessions with an open stream" below for the others.
  describe("idle-gated session termination", () => {
    it("ends an idle session that did not re-fetch once the window passes", async () => {
      const a = attach("a");
      reloader.reloadNow(NS, "manual");

      await vi.advanceTimersByTimeAsync(9_999);
      expect(a.end).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      expect(a.end).toHaveBeenCalledOnce();
      expect(reloader.sessionCounts()).toEqual({});
    });

    it("waits for an in-flight call to return before ending the session", async () => {
      const a = attach("a");
      a.transport.request(7, "tools/call");
      reloader.reloadNow(NS, "manual");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.end).not.toHaveBeenCalled();

      await a.transport.respond(7);
      expect(a.transport.sent.at(-1)).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: {},
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(a.end).toHaveBeenCalledOnce();
    });

    it("waits for every concurrent call, not just the first", async () => {
      const a = attach("a");
      a.transport.request(1, "tools/call");
      a.transport.request(2, "tools/call");
      reloader.reloadNow(NS, "manual");
      await vi.advanceTimersByTimeAsync(10_001);

      await a.transport.respond(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(a.end).not.toHaveBeenCalled();

      await a.transport.respond(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(a.end).toHaveBeenCalledOnce();
    });

    it("does not end a session when a call arrives just as it was about to be ended", async () => {
      const a = attach("a");
      reloader.reloadNow(NS, "manual");
      await vi.advanceTimersByTimeAsync(10_000);

      // The end is deferred one tick; a call slips in before it runs.
      a.transport.request(3, "tools/call");
      await vi.advanceTimersByTimeAsync(1);
      expect(a.end).not.toHaveBeenCalled();

      await a.transport.respond(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(a.end).toHaveBeenCalledOnce();
    });

    it("spares an overdue session that re-fetches before it goes idle", async () => {
      const a = attach("a");
      a.transport.request(1, "tools/call");
      reloader.reloadNow(NS, "manual");
      await vi.advanceTimersByTimeAsync(10_001);

      a.transport.request(2, "tools/list");
      await a.transport.respond(2);
      await a.transport.respond(1);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(a.end).not.toHaveBeenCalled();
    });

    it("does not count client notifications as work in flight", async () => {
      const a = attach("a");
      a.transport.onmessage?.({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      reloader.reloadNow(NS, "manual");
      await vi.advanceTimersByTimeAsync(10_001);
      expect(a.end).toHaveBeenCalledOnce();
    });

    it("gives a fresh window when a second change arrives", async () => {
      const a = attach("a");
      reloader.reloadNow(NS, "first");
      await vi.advanceTimersByTimeAsync(8_000);
      reloader.reloadNow(NS, "second");
      await vi.advanceTimersByTimeAsync(8_000);
      expect(a.end).not.toHaveBeenCalled();

      a.transport.request(1, "tools/list");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.end).not.toHaveBeenCalled();
    });
  });

  describe("sessions with an open stream", () => {
    it("tells a session with an open stream and never ends it, re-fetch or not", async () => {
      // Codex ignores list_changed by default and keeps its old list even
      // after a 404 and re-initialise, so ending it would fix nothing.
      const a = attach("a");
      reloader.streamOpened("a");
      reloader.reloadNow(NS, "manual");

      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.transport.listChangedCount()).toBe(1);
      expect(a.end).not.toHaveBeenCalled();
    });

    it("treats an SSE session (attached with its stream open) the same way", async () => {
      const transport = new FakeTransport();
      const end = vi.fn(async () => {});
      reloader.attach("sse", NS, transport, end, { streamOpen: true });
      reloader.reloadNow(NS, "manual");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(transport.listChangedCount()).toBe(1);
      expect(end).not.toHaveBeenCalled();
    });

    it("counts a stream opened before the session was attached", async () => {
      reloader.streamOpened("a");
      const a = attach("a");
      reloader.reloadNow(NS, "manual");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.end).not.toHaveBeenCalled();
    });

    it("re-sends a missed notification when the stream comes back within the window", async () => {
      // Claude Code reopens its GET stream about a second after it drops.
      const a = attach("a");
      reloader.reloadNow(NS, "manual");
      await vi.advanceTimersByTimeAsync(1_000);

      reloader.streamOpened("a");
      expect(a.transport.listChangedCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.end).not.toHaveBeenCalled();
    });

    it("spares an overdue session still busy with a call if its stream comes back", async () => {
      const a = attach("a");
      a.transport.request(1, "tools/call");
      reloader.reloadNow(NS, "manual");
      await vi.advanceTimersByTimeAsync(10_001);

      reloader.streamOpened("a");
      await a.transport.respond(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.end).not.toHaveBeenCalled();
      expect(a.transport.listChangedCount()).toBe(2);
    });

    it("keeps the stream open when a refused second GET closes", async () => {
      const a = attach("a");
      reloader.streamOpened("a");
      reloader.streamOpened("a"); // second GET, answered 409
      reloader.streamClosed("a");
      reloader.reloadNow(NS, "manual");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.end).not.toHaveBeenCalled();
    });

    it("ends a session whose stream closed and that did not re-fetch", async () => {
      // A client that went away without DELETE: its GET stream is gone.
      const a = attach("a");
      reloader.streamOpened("a");
      reloader.streamClosed("a");
      reloader.reloadNow(NS, "manual");
      await vi.advanceTimersByTimeAsync(10_001);
      expect(a.end).toHaveBeenCalledOnce();
    });
  });
});
