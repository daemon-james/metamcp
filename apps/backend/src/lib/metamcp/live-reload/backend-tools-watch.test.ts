import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { BackendToolsWatch } from "./backend-tools-watch";

const tool = (name: string, description = `${name} tool`): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties: {} },
});

describe("BackendToolsWatch", () => {
  it("treats the first list seen from a server as the baseline, not a change", () => {
    const watch = new BackendToolsWatch();
    expect(watch.observe("chatwoot", [tool("a")])).toBe(false);
  });

  it("sees no change when the same tools come back in another order", () => {
    const watch = new BackendToolsWatch();
    watch.observe("chatwoot", [tool("a"), tool("b")]);
    expect(watch.observe("chatwoot", [tool("b"), tool("a")])).toBe(false);
  });

  it("sees a respawn that serves a different set of tools", () => {
    const watch = new BackendToolsWatch();
    watch.observe("chatwoot", [tool("list_inboxes"), tool("send_message")]);
    expect(watch.observe("chatwoot", [tool("search"), tool("execute")])).toBe(
      true,
    );
  });

  it("sees a changed description or schema, not just changed names", () => {
    const watch = new BackendToolsWatch();
    watch.observe("postmark", [tool("send", "Send an email")]);
    expect(watch.observe("postmark", [tool("send", "Send an e-mail")])).toBe(
      true,
    );

    expect(
      watch.observe("postmark", [
        {
          ...tool("send", "Send an e-mail"),
          inputSchema: {
            type: "object",
            properties: { to: { type: "string" } },
          },
        },
      ]),
    ).toBe(true);
  });

  it("reports a change once, then compares against the new list", () => {
    const watch = new BackendToolsWatch();
    watch.observe("chatwoot", [tool("a")]);
    expect(watch.observe("chatwoot", [tool("b")])).toBe(true);
    expect(watch.observe("chatwoot", [tool("b")])).toBe(false);
  });

  it("keeps each server's baseline separately", () => {
    const watch = new BackendToolsWatch();
    watch.observe("chatwoot", [tool("a")]);
    expect(watch.observe("postmark", [tool("b")])).toBe(false);
    expect(watch.observe("chatwoot", [tool("a")])).toBe(false);
  });
});
