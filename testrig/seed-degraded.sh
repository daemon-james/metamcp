#!/usr/bin/env bash
# Seed a namespace that contains failure modes, not just healthy backends.
# Use this to prove a resilience fix actually holds: a hung backend must not
# stall tools/list for the other 14, and a slow one must not time the client out.
#   12 healthy, 1 slow (5s tools/list), 1 hung (never answers), 1 that exits
RIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -euo pipefail
PSQL=(docker exec metamcp-test-pg psql -U metamcp_user -d metamcp_test -q -t)
"${PSQL[@]}" -c "DELETE FROM namespace_server_mappings; DELETE FROM mcp_servers;" >/dev/null
UID_=$("${PSQL[@]}" -c "SELECT id FROM users LIMIT 1;" | tr -d ' \n')
NS=$("${PSQL[@]}" -c "SELECT uuid FROM namespaces WHERE name='loadtest';" | tr -d ' \n')
add() { # name, env-json, command, args-array
  "${PSQL[@]}" -c "
    WITH s AS (
      INSERT INTO mcp_servers (name, type, command, args, env, user_id)
      VALUES ('$1','STDIO','$3',$4,'$2'::jsonb,'$UID_') RETURNING uuid)
    INSERT INTO namespace_server_mappings (namespace_uuid, mcp_server_uuid, status)
    SELECT '$NS', uuid, 'ACTIVE' FROM s;" >/dev/null
}
ARGS="ARRAY['"$RIG"/fake-mcp-server.js']"
for i in $(seq 1 12); do add "healthy$i" "{\"FAKE_NAME\":\"healthy$i\",\"FAKE_TOOLS\":\"5\"}" node "$ARGS"; done
add "slow"    '{"FAKE_NAME":"slow","FAKE_TOOLS":"5","FAKE_LIST_MS":"5000"}' node "$ARGS"
add "hung"    '{"FAKE_NAME":"hung","FAKE_TOOLS":"5","FAKE_HANG":"1"}'       node "$ARGS"
add "missing" '{}' /nonexistent/binary "ARRAY['x']"
echo "seeded 12 healthy + slow + hung + missing"
echo "healthy tools = 60; slow adds 5 after 5s; hung and missing add 0"
