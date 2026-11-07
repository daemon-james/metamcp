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
    reloader.attach(sessionId, namespaceUuid, transport);
    return { transport };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    beforeNotify = vi.fn<(namespaceUuid: string) => void>();
    reloader = new ToolListReloader({
      debounceMs: 3_000,
      maxDelayMs: 15_000,
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

    it("does not throw when a session cannot be sent the notification", () => {
      const a = attach("a");
      a.transport.failSends = true;
      expect(() => reloader.reloadNow(NS, "manual")).not.toThrow();
    });

    it("forgets a detached session", () => {
      attach("a");
      reloader.detach("a");
      expect(reloader.reloadNow(NS, "manual")).toBe(0);
    });
  });

  describe("sessions without an open stream", () => {
    it("never ends a session, whatever it does", async () => {
      // Ending sessions cut agents off mid-task; Cursor's CLI never recovers.
      const closed = vi.fn();
      const a = attach("a");
      a.transport.close = closed;
      a.transport.request(1, "tools/call");
      for (let i = 0; i < 5; i += 1) {
        reloader.reloadNow(NS, "manual");
        await vi.advanceTimersByTimeAsync(60_000);
      }
      await a.transport.respond(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(closed).not.toHaveBeenCalled();
      expect(reloader.sessionCounts()).toEqual({ [NS]: 1 });
    });

    it("re-sends a missed notification when the stream comes back", () => {
      // Claude Code reopens its GET stream about a second after it drops.
      const a = attach("a");
      reloader.reloadNow(NS, "manual");
      reloader.streamOpened("a");
      expect(a.transport.listChangedCount()).toBe(2);

      // Only once: a later reopen with nothing missed sends nothing.
      reloader.streamClosed("a");
      reloader.streamOpened("a");
      expect(a.transport.listChangedCount()).toBe(2);
    });

    it("does not re-send to a session that listed its tools in the meantime", () => {
      const a = attach("a");
      reloader.reloadNow(NS, "manual");
      a.transport.request(1, "tools/list");
      reloader.streamOpened("a");
      expect(a.transport.listChangedCount()).toBe(1);
    });
  });

  describe("sessions with an open stream", () => {
    it("tells a session with an open stream once and does not re-send", () => {
      const a = attach("a");
      reloader.streamOpened("a");
      reloader.reloadNow(NS, "manual");
      reloader.streamClosed("a");
      reloader.streamOpened("a");
      expect(a.transport.listChangedCount()).toBe(1);
    });

    it("treats an SSE session (attached with its stream open) the same way", () => {
      const transport = new FakeTransport();
      reloader.attach("sse", NS, transport, { streamOpen: true });
      reloader.reloadNow(NS, "manual");
      expect(transport.listChangedCount()).toBe(1);
    });

    it("counts a stream opened before the session was attached", () => {
      reloader.streamOpened("a");
      const a = attach("a");
      reloader.reloadNow(NS, "manual");
      reloader.streamOpened("a");
      expect(a.transport.listChangedCount()).toBe(1);
    });

    it("keeps the stream open when a refused second GET closes", () => {
      const a = attach("a");
      reloader.streamOpened("a");
      reloader.streamOpened("a"); // second GET, answered 409
      reloader.streamClosed("a");
      reloader.reloadNow(NS, "manual");
      reloader.streamOpened("a");
      expect(a.transport.listChangedCount()).toBe(1);
    });
  });
});
