#!/usr/bin/env bash
# Seed N fake stdio backends into the loadtest namespace. Idempotent.
RIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -euo pipefail
N="${1:-15}"
TOOLS="${2:-5}"
PSQL=(docker exec metamcp-test-pg psql -U metamcp_user -d metamcp_test -q -t)
"${PSQL[@]}" -c "DELETE FROM namespace_server_mappings; DELETE FROM mcp_servers;" >/dev/null
UID_=$("${PSQL[@]}" -c "SELECT id FROM users LIMIT 1;" | tr -d ' \n')
NS=$("${PSQL[@]}" -c "SELECT uuid FROM namespaces WHERE name='loadtest';" | tr -d ' \n')
for i in $(seq 1 "$N"); do
  "${PSQL[@]}" -c "
    WITH s AS (
      INSERT INTO mcp_servers (name, type, command, args, env, user_id)
      VALUES ('fake$i', 'STDIO', 'node',
              ARRAY['"$RIG"/fake-mcp-server.js'],
              '{\"FAKE_NAME\":\"fake$i\",\"FAKE_TOOLS\":\"$TOOLS\"}'::jsonb,
              '$UID_')
      RETURNING uuid)
    INSERT INTO namespace_server_mappings (namespace_uuid, mcp_server_uuid, status)
    SELECT '$NS', uuid, 'ACTIVE' FROM s;" >/dev/null
done
echo "seeded $N fake backends x $TOOLS tools = $((N*TOOLS)) tools expected"
