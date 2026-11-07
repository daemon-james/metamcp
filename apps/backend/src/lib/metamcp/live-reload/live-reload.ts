// Live tool-list reloading: wires the change detectors to the reloader.
//
// Two detectors, one per kind of change:
//   - configuration: the database is read every few seconds and compared with
//     the previous reading (config-snapshot.ts). Catches servers added,
//     removed, edited, mapped/unmapped and tool overrides changed, whether
//     through the UI or direct SQL.
//   - backends: each connection's tool list is hashed when the connection
//     opens and whenever the backend says its list changed, and compared per
//     connection (backend-tools-watch.ts). Catches a respawned process serving
//     a different build without mistaking two pooled connections that serve
//     different lists for a change.
// Both end in `toolListReloader.changed(namespace)`, which coalesces bursts and
// brings every connected session up to date (tool-list-reloader.ts).

import {
  Tool,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ServerParameters } from "@repo/zod-types";
import { sql } from "drizzle-orm";

import logger from "@/utils/logger";

import { db } from "../../../db/index";
import { namespaceMappingsRepository } from "../../../db/repositories/namespace-mappings.repo";
import type { ConnectedClient } from "../client";
import { serverRequiresForwardedHeaders } from "../header-forwarding";
import { clearFilterCache } from "../metamcp-middleware/filter-tools.functional";
import { clearOverrideCache } from "../metamcp-middleware/tool-overrides.functional";
import { BackendToolsWatch } from "./backend-tools-watch";
import {
  ConfigSnapshot,
  diffConfigSnapshots,
  NamespaceFingerprint,
} from "./config-snapshot";
import { ToolListReloader } from "./tool-list-reloader";

const CONFIG_POLL_INTERVAL_MS = 5_000;
const BACKEND_LIST_TIMEOUT_MS = 15_000;

export const toolListReloader = new ToolListReloader({
  debounceMs: 3_000,
  maxDelayMs: 15_000,
  // Both caches can hold a tool's old status or override; the persistent
  // override entries never expire on their own.
  beforeNotify: (namespaceUuid) => {
    clearOverrideCache(namespaceUuid);
    clearFilterCache(namespaceUuid);
  },
});

const backendToolsWatch = new BackendToolsWatch<ConnectedClient>();

/** Compare a tool list just fetched on one connection with what it served. */
async function noteBackendTools(
  params: ServerParameters,
  connected: ConnectedClient,
  tools: Tool[],
): Promise<void> {
  // Forwarded headers carry each caller's own credentials, so different
  // sessions may legitimately see different lists from the same server.
  if (serverRequiresForwardedHeaders(params)) return;
  if (!backendToolsWatch.observe(params.uuid, connected, tools)) return;

  const namespaceUuids =
    await namespaceMappingsRepository.findNamespacesByServerUuid(params.uuid);
  for (const namespaceUuid of namespaceUuids) {
    toolListReloader.changed(
      namespaceUuid,
      `${params.name} now serves a different tool list`,
    );
  }
}

/**
 * Check a new backend connection's tool list now, and again whenever the
 * backend says its list changed.
 */
export function watchConnectionTools(
  params: ServerParameters,
  connected: ConnectedClient,
): void {
  const check = async () => {
    if (!connected.client.getServerCapabilities()?.tools) return;
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await connected.client.listTools(
        cursor ? { cursor } : undefined,
        { timeout: BACKEND_LIST_TIMEOUT_MS },
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    await noteBackendTools(params, connected, tools);
  };
  const run = () => {
    check().catch((error) => {
      logger.warn(
        `Tool list check for ${params.name} (${params.uuid}) failed:`,
        error,
      );
    });
  };

  connected.client.setNotificationHandler(
    ToolListChangedNotificationSchema,
    async () => run(),
  );
  const previousOnClose = connected.client.onclose;
  connected.client.onclose = () => {
    previousOnClose?.();
    backendToolsWatch.forget(params.uuid, connected);
  };
  run();
}

type Row = Record<string, string>;

/** Read the fingerprints of everything that decides a namespace's tools. */
export async function readConfigSnapshot(): Promise<ConfigSnapshot> {
  const [servers, mappings, toolMappings] = await Promise.all([
    db.execute(sql`
      SELECT s.uuid::text AS uuid,
             md5(row(s.type, s.command, s.args, s.env, s.url, s.bearer_token,
                     s.headers, s.forward_headers)::text) AS conn,
             md5(s::text) AS full_row
        FROM mcp_servers s`),
    db.execute(sql`
      SELECT namespace_uuid::text AS namespace_uuid,
             mcp_server_uuid::text AS server_uuid,
             status::text AS status
        FROM namespace_server_mappings`),
    db.execute(sql`
      SELECT t.namespace_uuid::text AS namespace_uuid,
             md5(string_agg(md5(t::text), ',' ORDER BY t.uuid)) AS fingerprint
        FROM namespace_tool_mappings t
       GROUP BY t.namespace_uuid`),
  ]);

  const snapshot: ConfigSnapshot = {
    servers: new Map(),
    namespaces: new Map(),
  };
  const namespace = (uuid: string): NamespaceFingerprint => {
    let found = snapshot.namespaces.get(uuid);
    if (!found) {
      found = { servers: new Map(), toolMappings: "" };
      snapshot.namespaces.set(uuid, found);
    }
    return found;
  };

  for (const row of servers.rows as Row[]) {
    snapshot.servers.set(row.uuid, { connection: row.conn, row: row.full_row });
  }
  for (const row of mappings.rows as Row[]) {
    namespace(row.namespace_uuid).servers.set(row.server_uuid, row.status);
  }
  for (const row of toolMappings.rows as Row[]) {
    namespace(row.namespace_uuid).toolMappings = row.fingerprint;
  }
  return snapshot;
}

/**
 * Poll the configuration and act on changes. `retireServer` drops a server's
 * pooled connections so the next use reconnects with the current settings.
 * Returns a function that stops the polling.
 */
export function startConfigWatch(
  retireServer: (serverUuid: string) => Promise<void>,
  intervalMs: number = CONFIG_POLL_INTERVAL_MS,
): () => void {
  let previous: ConfigSnapshot | undefined;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const next = await readConfigSnapshot();
      if (previous) {
        const changes = diffConfigSnapshots(previous, next);
        for (const serverUuid of changes.retireServers) {
          logger.info(
            `Tool list config watch: connection settings of server ${serverUuid} changed or it was deleted; retiring its pooled connections`,
          );
          await retireServer(serverUuid).catch((error) => {
            logger.error(
              `Tool list config watch: could not retire server ${serverUuid}:`,
              error,
            );
          });
        }
        for (const namespaceUuid of changes.namespaces) {
          toolListReloader.changed(namespaceUuid, "configuration changed");
        }
      }
      previous = next;
    } catch (error) {
      // Keep the last good reading; the next tick compares against it.
      logger.warn(
        "Tool list config watch: could not read configuration:",
        error,
      );
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
