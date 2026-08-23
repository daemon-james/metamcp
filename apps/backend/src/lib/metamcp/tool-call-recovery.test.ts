import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isBackendSessionLostError,
  isSafeToReplayToolCallError,
} from "./session-error";

const proxySource = readFileSync(
  fileURLToPath(new URL("./metamcp-proxy.ts", import.meta.url)),
  "utf8",
);

/**
 * Guards the tools/call recovery gate in metamcp-proxy.ts.
 *
 * That handler cannot be driven from a unit test without standing up a whole
 * namespace, a pool and a backend, so the regression is pinned at the source
 * level instead. It is worth pinning: the handler shipped for months gated on
 * the NARROW predicate, which silently excluded every "Not connected" failure
 * — the common case — from a recovery path that was otherwise fully built and
 * working. Production 2026-08-13: 5 tool-call failures, 0 recovery attempts.
 */
describe("tools/call recovery gate", () => {
  it("classifies a torn-down transport as recoverable, and the narrow predicate does not", () => {
    const transportLost = new Error("Not connected");

    expect(isSafeToReplayToolCallError(transportLost)).toBe(true);
    // Precisely why the narrow predicate is the wrong gate for tools/call.
    expect(isBackendSessionLostError(transportLost)).toBe(false);
  });

  it("gates the tools/call retry on the replay-safe predicate", () => {
    expect(proxySource).toContain("if (!isSafeToReplayToolCallError(error)) {");
  });

  it("does not import the narrow predicate into the proxy", () => {
    // Importing it back is the exact shape of the original regression.
    expect(proxySource).not.toMatch(
      /import\s*\{[^}]*isBackendSessionLostError[^}]*\}\s*from\s*"\.\/session-error"/,
    );
  });
});
