import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { BackendToolsWatch } from "./backend-tools-watch";

const tool = (name: string, description = `${name} tool`): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

// Stand-ins for pooled connections; only their identity matters.
const conn = () => ({});

describe("BackendToolsWatch", () => {
  it("treats the first list seen from a server as the baseline, not a change", () => {
    const watch = new BackendToolsWatch();
    expect(watch.observe("chatwoot", conn(), [tool("a")])).toBe(false);
  });

  it("sees no change when the same tools come back in another order", () => {
    const watch = new BackendToolsWatch();
    const c = conn();
    watch.observe("chatwoot", c, [tool("a"), tool("b")]);
    expect(watch.observe("chatwoot", c, [tool("b"), tool("a")])).toBe(false);
  });

  it("sees no change when only the order of keys in a definition differs", () => {
    const watch = new BackendToolsWatch();
    const c = conn();
    watch.observe("stripe", c, [
      {
        name: "a",
        description: "d",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    expect(
      watch.observe("stripe", c, [
        {
          inputSchema: { properties: {}, type: "object" },
          description: "d",
          name: "a",
        },
      ]),
    ).toBe(false);
  });

  it("sees a connection whose backend now serves a different list", () => {
    const watch = new BackendToolsWatch();
    const c = conn();
    watch.observe("chatwoot", c, [tool("list_inboxes")]);
    expect(watch.observe("chatwoot", c, [tool("search")])).toBe(true);
    expect(watch.observe("chatwoot", c, [tool("search")])).toBe(false);
  });

  it("sees a changed description or schema, not just changed names", () => {
    const watch = new BackendToolsWatch();
    const c = conn();
    watch.observe("postmark", c, [tool("send", "Send an email")]);
    expect(watch.observe("postmark", c, [tool("send", "Send an e-mail")])).toBe(
      true,
    );
  });

  it("sees a respawn serving a new build after the old connections closed", () => {
    const watch = new BackendToolsWatch();
    const old = conn();
    watch.observe("chatwoot", old, [tool("list_inboxes")]);
    watch.forget("chatwoot", old);
    expect(watch.observe("chatwoot", conn(), [tool("search")])).toBe(true);
  });

  it("sees no change when a respawn serves the same build", () => {
    const watch = new BackendToolsWatch();
    const old = conn();
    watch.observe("chatwoot", old, [tool("a")]);
    watch.forget("chatwoot", old);
    expect(watch.observe("chatwoot", conn(), [tool("a")])).toBe(false);
  });

  it("reports two connections on different versions once, not on every listing", () => {
    // 7 Nov 2026: uvx ha-mcp@latest left one process on 9.1.0 and one on
    // 9.1.1; comparing across them announced a change every few seconds.
    const watch = new BackendToolsWatch();
    const older = conn();
    const newer = conn();
    watch.observe("homeassistant", older, [tool("a")]);
    expect(watch.observe("homeassistant", newer, [tool("a"), tool("b")])).toBe(
      true,
    );
    for (let i = 0; i < 5; i += 1) {
      expect(watch.observe("homeassistant", older, [tool("a")])).toBe(false);
      expect(
        watch.observe("homeassistant", newer, [tool("a"), tool("b")]),
      ).toBe(false);
    }
  });

  it("sees no change when a new connection serves what another live one serves", () => {
    const watch = new BackendToolsWatch();
    const first = conn();
    const second = conn();
    watch.observe("stripe", first, [tool("a")]);
    watch.observe("stripe", second, [tool("a"), tool("b")]);
    expect(watch.observe("stripe", conn(), [tool("a")])).toBe(false);
  });

  it("does not count a closed connection's list when the old one closes", () => {
    const watch = new BackendToolsWatch();
    const older = conn();
    const newer = conn();
    watch.observe("homeassistant", older, [tool("a")]);
    watch.observe("homeassistant", newer, [tool("a"), tool("b")]);
    watch.forget("homeassistant", older);
    expect(watch.observe("homeassistant", conn(), [tool("a"), tool("b")])).toBe(
      false,
    );
  });

  it("keeps each server's baseline separately", () => {
    const watch = new BackendToolsWatch();
    const c = conn();
    watch.observe("chatwoot", c, [tool("a")]);
    expect(watch.observe("postmark", conn(), [tool("b")])).toBe(false);
    expect(watch.observe("chatwoot", c, [tool("a")])).toBe(false);
  });
});
