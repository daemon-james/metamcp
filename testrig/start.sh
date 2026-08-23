#!/usr/bin/env bash
# Run the MetaMCP backend from source against the scratch DB on :12009.
# Edit source, re-run this, and you are testing in ~10s instead of a 3min
# docker build against production.
RIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -euo pipefail
cd /home/dev/projects/metamcp/apps/backend
if [ -f "$RIG"/app.pid ]; then
  kill "$(cat "$RIG"/app.pid)" 2>/dev/null || true
  rm -f "$RIG"/app.pid
  sleep 2
fi
# Reap orphaned upstream children. Node does not kill its stdio children on
# exit, so every restart otherwise strands the previous run's backends. Left
# alone they accumulate (125 seen after one afternoon of restarts) and any
# process-count measurement in fanout.sh becomes meaningless.
pkill -f "$RIG/fake-mcp-server.js" 2>/dev/null || true
sleep 1
set -a; . /tmp/metamcp-test.env; set +a
: > /tmp/metamcp-test.log
nohup npx tsx src/index.ts > /tmp/metamcp-test.log 2>&1 &
echo $! > "$RIG"/app.pid
until grep -qE "Server is running on port 12009" /tmp/metamcp-test.log 2>/dev/null; do
  if ! kill -0 "$(cat "$RIG"/app.pid)" 2>/dev/null; then
    echo "BACKEND DIED:"; tail -20 /tmp/metamcp-test.log; exit 1
  fi
  sleep 1
done
echo "backend up on http://10.10.10.20:12009 (pid $(cat "$RIG"/app.pid))"
