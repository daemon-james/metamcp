#!/usr/bin/env bash
# N concurrent MCP sessions against the local rig. Reports the tool count each
# session saw (they must all match), latency spread, and what the pool spent.
# Usage: fanout.sh [N] [expected_tools]
RIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
N="${1:-12}"; EXPECT="${2:-75}"
export METAMCP_TEST_KEY="${METAMCP_TEST_KEY:?}"
before_pids=$(pgrep -fc "fake-mcp-server.js" || echo 0)
out=$(mktemp)
for i in $(seq 1 "$N"); do "$RIG"/probe.sh "s$i" >> "$out" 2>&1 & done
wait
sort -t= -k4 -n "$out"
echo "---"
bad=$(awk -v e="$EXPECT" '$NF != "tools="e' "$out" | wc -l)
echo "sessions: $N | wrong tool count: $bad (expected every session to see $EXPECT)"
awk -F'list=' '{split($2,a,"ms"); print a[1]}' "$out" | sort -n | awk '
  {v[NR]=$1} END {printf "list latency: min=%dms median=%dms max=%dms\n", v[1], v[int((NR+1)/2)], v[NR]}'
after_pids=$(pgrep -fc "fake-mcp-server.js" || echo 0)
echo "fake-server processes: before=$before_pids after=$after_pids"
echo "pool cap refusals: $(grep -c 'Connection limit reached' /tmp/metamcp-test.log || echo 0) global, $(grep -c 'Per-server connection limit' /tmp/metamcp-test.log || echo 0) per-server"
echo "DEGRADED responses: $(grep -c 'DEGRADED' /tmp/metamcp-test.log || echo 0)"
rm -f "$out"
