// Classification of connection failures that retrying cannot resolve.
//
// The retry loop treats every failure as transient: three attempts five
// seconds apart, then a re-dial every ten minutes for as long as the server is
// configured. That is right for an unreachable host or a restarting process,
// and pointless for a disagreement about the protocol itself — the answer will
// be identical every time. Worse, the operator is told only "connection
// failed", when the actual problem is that the two ends cannot speak a common
// version and no amount of waiting will change it.

/**
 * A protocol-version mismatch reported by the SDK during `initialize`.
 *
 * The SDK sends its latest supported version and throws when the server
 * answers with one outside the range it understands. Both sides have then
 * stated their positions and neither will move.
 */
export function isUnsupportedProtocolVersionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /protocol version is not supported/i.test(error.message);
}

/**
 * Failures where another attempt cannot produce a different outcome. Callers
 * should stop retrying and record why, rather than spending the remaining
 * budget re-asking the same question.
 */
export function isTerminalConnectionError(error: unknown): boolean {
  return isUnsupportedProtocolVersionError(error);
}

/** Operator-facing explanation for a terminal failure. */
export function describeTerminalConnectionError(error: unknown): string {
  if (isUnsupportedProtocolVersionError(error)) {
    return `incompatible MCP protocol version — ${
      error instanceof Error ? error.message : "no common version"
    }`;
  }
  return error instanceof Error ? error.message : "unknown error";
}
