// Pure header-merging helper. Kept out of `client.ts` so it can be unit
// tested without importing the repositories, which open the database at
// import time.

/**
 * Overlay our own headers onto the ones the MCP SDK built, case-insensitively.
 *
 * The SDK's SSE transport constructs the request headers itself —
 * `_commonHeaders()` adds `mcp-protocol-version` and already folds in
 * `requestInit.headers`, then `_startOrAuth` sets `Accept: text/event-stream`
 * — and passes them to the injected `fetch`. Two obvious ways to combine them
 * are both wrong:
 *
 *   - Replacing wholesale drops `Accept` and the protocol version. Both are
 *     required by the spec and strict servers answer 406.
 *   - Spreading into a plain object produces duplicates that differ only by
 *     case, because `_commonHeaders()` normalises to lower case while our own
 *     record preserves whatever casing was configured. `fetch` then joins them
 *     — `Bearer x, Bearer x` — and the server rejects every request with 401,
 *     which looks exactly like a bad credential.
 *
 * `Headers.set` matches case-insensitively, so each name survives once with
 * our value winning.
 */
export const mergeSdkHeaders = (
  sdkHeaders: ConstructorParameters<typeof Headers>[0] | undefined,
  overrides: Record<string, string>,
): Headers => {
  const merged = new Headers(sdkHeaders ?? {});
  for (const [name, value] of Object.entries(overrides)) {
    merged.set(name, value);
  }
  return merged;
};
