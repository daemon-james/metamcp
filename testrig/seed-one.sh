#!/usr/bin/env bash
# Seed N healthy backends plus ONE injected fault, so a stall can be attributed.
#   seed-one.sh hung|slow|missing|none [healthy_count]
RIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -euo pipefail
FAULT="${1:-none}"; N="${2:-4}"
PSQL=(docker exec metamcp-test-pg psql -U metamcp_user -d metamcp_test -q -t)
"${PSQL[@]}" -c "DELETE FROM namespace_server_mappings; DELETE FROM mcp_servers;" >/dev/null
UID_=$("${PSQL[@]}" -c "SELECT id FROM users LIMIT 1;" | tr -d ' \n')
NS=$("${PSQL[@]}" -c "SELECT uuid FROM namespaces WHERE name='loadtest';" | tr -d ' \n')
add() { "${PSQL[@]}" -c "
  WITH s AS (INSERT INTO mcp_servers (name,type,command,args,env,user_id)
    VALUES ('$1','STDIO','$3',$4,'$2'::jsonb,'$UID_') RETURNING uuid)
  INSERT INTO namespace_server_mappings (namespace_uuid,mcp_server_uuid,status)
  SELECT '$NS',uuid,'ACTIVE' FROM s;" >/dev/null; }
A="ARRAY['"$RIG"/fake-mcp-server.js']"
for i in $(seq 1 "$N"); do add "healthy$i" "{\"FAKE_NAME\":\"healthy$i\",\"FAKE_TOOLS\":\"5\"}" node "$A"; done
case "$FAULT" in
  hung)    add hung    '{"FAKE_NAME":"hung","FAKE_TOOLS":"5","FAKE_HANG":"1"}'        node "$A";;
  slow)    add slow    '{"FAKE_NAME":"slow","FAKE_TOOLS":"5","FAKE_LIST_MS":"5000"}'  node "$A";;
  missing) add missing '{}' /nonexistent/binary "ARRAY['x']";;
  none)    ;;
esac
echo "seeded $N healthy + fault=$FAULT (healthy tools = $((N*5)))"
