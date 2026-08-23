#!/usr/bin/env bash
# Run the MetaMCP backend from source against the scratch DB on :12009.
# Edit source, re-run this, and you are testing in ~10s instead of a 3min
# docker build against production.
RIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -euo pipefail
# Which checkout to run. Defaults to the main one; point METAMCP_REPO at a
# fleet worktree to measure that branch's edits without merging first.
# Note the backend hardcodes app.listen(12009), so only ONE instance can run at
# a time whichever checkout it comes from. Two agents racing for that port is
# how a stale process silently served an entire fault matrix on 2026-08-23.
REPO="${METAMCP_REPO:-/home/dev/projects/metamcp}"
cd "$REPO/apps/backend"
# Kill by PORT, not just by pid file. A backend started outside this script
# (a raw nohup, a crashed run whose pid file was overwritten) keeps :12009 and
# silently serves every probe, so the rig measures code you are not editing.
# That happened on 2026-08-23: a process from three hours earlier answered a
# whole fault matrix and made a working fix look broken.
for _ in 1 2 3; do
  # `|| true`: under `set -euo pipefail` a grep that matches nothing returns 1
  # and kills the script silently, which looks exactly like a clean start.
  holder="$(ss -ltnp 2>/dev/null | grep ':12009 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
  [ -z "$holder" ] && break
  kill "$holder" 2>/dev/null || true
  sleep 2
done
if ss -ltn 2>/dev/null | grep -q ':12009 '; then
  echo "PORT 12009 STILL HELD after 3 kill attempts; refusing to start and report stale results" >&2
  exit 1
fi
rm -f "$RIG"/app.pid
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
