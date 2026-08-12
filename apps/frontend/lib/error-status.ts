import { McpServerErrorStatusEnum } from "@repo/zod-types";

/**
 * Presentation for a server's `error_status`.
 *
 * The three states call for three different responses from whoever is looking
 * at the screen, so they must not render alike:
 *
 *   NONE          nothing to do.
 *   UNAUTHORIZED  the upstream rejected our credentials. Retrying cannot fix
 *                 it; a person has to authorise the server again. Rendered as
 *                 a warning rather than a destructive error because nothing is
 *                 broken — the grant simply lapsed — and it is actionable in
 *                 one click.
 *   ERROR         failed for some other reason: crashed process, unreachable
 *                 host, rejected handshake. Usually transient, nothing for the
 *                 operator to supply.
 *
 * `canReconnect` marks the states where opening a connection is the remedy
 * rather than a pointless retry, which is what gates the Reconnect affordance.
 */
export interface ErrorStatusDisplay {
  variant: "success" | "warning" | "destructive";
  labelKey: string;
  canReconnect: boolean;
}

export function getErrorStatusDisplay(
  errorStatus: string | null | undefined,
  namespace: "list" | "detail" | "serversTable" = "list",
): ErrorStatusDisplay {
  const prefix =
    namespace === "serversTable"
      ? "namespaces:serversTable"
      : `mcp-servers:${namespace}`;

  switch (errorStatus) {
    case McpServerErrorStatusEnum.enum.UNAUTHORIZED:
      return {
        variant: "warning",
        labelKey: `${prefix}.unauthorized`,
        canReconnect: true,
      };
    case McpServerErrorStatusEnum.enum.ERROR:
      return {
        variant: "destructive",
        labelKey: `${prefix}.error`,
        canReconnect: false,
      };
    default:
      return {
        variant: "success",
        labelKey: `${prefix}.noError`,
        canReconnect: false,
      };
  }
}
