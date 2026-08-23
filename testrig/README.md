# MetaMCP local test rig

Iterate on the MetaMCP backend without building a Docker image or touching the
production container. Edit source, run `start.sh`, probe. Roughly 10 seconds a
cycle instead of three minutes, and production keeps serving throughout.

## Pieces

| Path | What it does |
| --- | --- |
| `start.sh` | (re)starts the backend from source on `:12009` against the scratch DB |
| `seed.sh N T` | N fake stdio backends advertising T tools each, all healthy |
| `seed-degraded.sh` | 12 healthy + one slow + one that never answers + one that fails to spawn |
| `probe.sh LABEL` | one MCP session: initialize, initialized, tools/list |
| `fanout.sh N EXPECT` | N concurrent sessions; flags any that saw the wrong tool count |
| `fake-mcp-server.js` | dependency-free stdio MCP server, ~40ms start |

Scratch Postgres runs as container `metamcp-test-pg` on host port 9434, database
`metamcp_test`. It shares nothing with production's `metamcp-pg` on 9433.

## Use

```bash
export METAMCP_TEST_KEY=$(docker exec metamcp-test-pg psql -U metamcp_user \
  -d metamcp_test -t -c "SELECT key FROM api_keys LIMIT 1;" | tr -d ' \n')

./seed.sh 15 5          # 15 backends x 5 tools = 75
./start.sh              # picks up any source edit
./fanout.sh 12 75       # every session must report tools=75
```

`fanout.sh` prints the per-session tool count, the latency spread, the count of
fake-server child processes before and after (a rising number is a process
leak), and how many times each connection cap fired.

## Why the fake backends

The bug that started this was the pool counting session references instead of
transports, which only shows up when many sessions share one backend. Real
upstreams make that slow and expensive to reproduce and drag live APIs into a
load test. These start in about 40ms, so a 15-backend namespace is cheap enough
to rebuild per run, and `seed-degraded.sh` makes the failure modes reproducible
on demand rather than waiting for one in production.

## Env

`/tmp/metamcp-test.env`. `MAX_TOTAL_CONNECTIONS` and `MAX_CONNECTIONS_PER_SERVER`
are set there and are the two knobs worth varying when testing pool behaviour.

## Teardown

```bash
kill "$(cat app.pid)"; docker rm -f metamcp-test-pg
```
