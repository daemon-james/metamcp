#!/usr/bin/env node
// Minimal stdio MCP server for load-testing MetaMCP's connection pool.
// No dependencies, starts in ~40ms, so a 15-backend namespace can be spun up
// and torn down repeatedly without waiting on npx or hitting a real API.
//
// Env:
//   FAKE_NAME       label used in tool names           (default "fake")
//   FAKE_TOOLS      how many tools to advertise        (default 5)
//   FAKE_LIST_MS    delay before answering tools/list  (default 0)
//   FAKE_HANG       if "1", never answer tools/list    (default off)
const NAME = process.env.FAKE_NAME || "fake";
const TOOLS = parseInt(process.env.FAKE_TOOLS || "5", 10);
const LIST_MS = parseInt(process.env.FAKE_LIST_MS || "0", 10);
const HANG = process.env.FAKE_HANG === "1";

const tools = Array.from({ length: TOOLS }, (_, i) => ({
  name: `${NAME}_tool_${i}`,
  description: `Test tool ${i} on ${NAME}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}));

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  const { id, method } = msg;
  if (id === undefined) return; // notification, nothing to answer

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: "1.0.0" },
      });
    case "tools/list":
      if (HANG) return; // never answers: exercises the caller's timeout
      return LIST_MS > 0
        ? setTimeout(() => reply(id, { tools }), LIST_MS)
        : reply(id, { tools });
    case "tools/call":
      return reply(id, {
        content: [{ type: "text", text: `${NAME} ok` }],
      });
    case "ping":
      return reply(id, {});
    default:
      return send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

process.stdin.resume();
