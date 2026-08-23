#!/usr/bin/env bash
# One MCP session against the local rig: initialize -> initialized -> tools/list.
# Prints: <label> init=<ms> list=<ms> tools=<n>
RIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://127.0.0.1:12009/metamcp/loadtest/mcp"
KEY="${METAMCP_TEST_KEY:?set METAMCP_TEST_KEY}"
LABEL="${1:-probe}"
H=(-H "X-API-Key: $KEY" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream")
hdr=$(mktemp); t0=$(date +%s%3N)
curl -sS -D "$hdr" "${H[@]}" -X POST "$URL" --max-time 120 -o /dev/null \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"rig","version":"1"}}}'
sid=$(grep -i '^mcp-session-id:' "$hdr" | tr -d '\r' | awk '{print $2}'); rm -f "$hdr"
init=$(( $(date +%s%3N) - t0 ))
[ -z "$sid" ] && { echo "$LABEL INIT_FAIL ${init}ms"; exit 1; }
curl -sS "${H[@]}" -H "mcp-session-id: $sid" -X POST "$URL" --max-time 30 -o /dev/null \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
t1=$(date +%s%3N)
body=$(curl -sS "${H[@]}" -H "mcp-session-id: $sid" -X POST "$URL" --max-time 120 \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
list=$(( $(date +%s%3N) - t1 ))
n=$(printf '%s' "$body" | grep -oE '"name":"[^"]*_tool_[0-9]+"' | wc -l)
echo "$LABEL init=${init}ms list=${list}ms tools=$n"
[ "${KEEP_SESSION:-0}" = "1" ] || curl -sS "${H[@]}" -H "mcp-session-id: $sid" -X DELETE "$URL" -o /dev/null --max-time 10 2>/dev/null
