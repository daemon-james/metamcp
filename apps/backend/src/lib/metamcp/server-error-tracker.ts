import {
  isFlaggedErrorStatus,
  McpServerErrorStatus,
  McpServerErrorStatusEnum,
} from "@repo/zod-types";

import logger from "@/utils/logger";

import { mcpServersRepository } from "../../db/repositories/index";
import { configService } from "../config.service";

export interface ServerCrashInfo {
  serverUuid: string;
  exitCode: number | null;
  signal: string | null;
  timestamp: Date;
}

export class ServerErrorTracker {
  private static instance: ServerErrorTracker | null = null;

  // Track crash attempts per server
  private crashAttempts: Map<string, number> = new Map();

  // Default max attempts before marking as ERROR (fallback if config is not available)
  private readonly fallbackMaxAttempts: number = 3;

  // Server-specific max attempts (can be configured per server)
  private serverMaxAttempts: Map<string, number> = new Map();

  private constructor() {}

  static getInstance(): ServerErrorTracker {
    if (!ServerErrorTracker.instance) {
      ServerErrorTracker.instance = new ServerErrorTracker();
    }
    return ServerErrorTracker.instance;
  }

  /**
   * Set max attempts for a specific server
   */
  setServerMaxAttempts(serverUuid: string, maxAttempts: number): void {
    this.serverMaxAttempts.set(serverUuid, maxAttempts);
  }

  /**
   * Get max attempts for a specific server
   */
  async getServerMaxAttempts(serverUuid: string): Promise<number> {
    // First check for server-specific configuration
    const serverSpecific = this.serverMaxAttempts.get(serverUuid);
    if (serverSpecific !== undefined) {
      return serverSpecific;
    }

    // Then check global configuration
    try {
      return await configService.getMcpMaxAttempts();
    } catch (error) {
      logger.warn(
        "Failed to get MCP max attempts from config, using fallback:",
        error,
      );
      return this.fallbackMaxAttempts;
    }
  }

  /**
   * Record a server crash and check if it should be marked as ERROR
   */
  async recordServerCrash(
    serverUuid: string,
    exitCode: number | null,
    signal: string | null,
  ): Promise<void> {
    logger.info(`recordServerCrash called for server ${serverUuid}`);

    // Get current attempt count
    const currentAttempts = this.crashAttempts.get(serverUuid) || 0;
    const newAttempts = currentAttempts + 1;

    // Update crash attempts tracking
    this.crashAttempts.set(serverUuid, newAttempts);

    const maxAttempts = await this.getServerMaxAttempts(serverUuid);

    logger.info(
      `Server ${serverUuid} crashed. Attempt ${newAttempts}/${maxAttempts}`,
    );

    // If we've reached max attempts, mark the server as ERROR
    if (newAttempts >= maxAttempts) {
      logger.warn(
        `Server ${serverUuid} has crashed ${newAttempts} times. Marking as ERROR.`,
      );

      try {
        await this.markServerAsError(serverUuid);

        // Log the crash info
        const crashInfo: ServerCrashInfo = {
          serverUuid,
          exitCode,
          signal,
          timestamp: new Date(),
        };

        logger.error(
          "Server marked as ERROR due to repeated crashes:",
          crashInfo,
        );
      } catch (error) {
        logger.error(`Failed to mark server ${serverUuid} as ERROR:`, error);
      }
    }
  }

  /**
   * Record a server that exhausted every connection attempt and mark it ERROR.
   *
   * `recordServerCrash` only ever fires from
   * `ProcessManagedStdioTransport.onprocesscrash`, so before this existed the
   * error status was reachable by STDIO servers alone: an SSE or
   * STREAMABLE_HTTP server whose handshake failed — expired OAuth token,
   * upstream down, wrong URL — exhausted its retries, returned `undefined`,
   * and stayed at `error_status = NONE` forever. It looked healthy in the UI,
   * stayed in the namespace pool poisoning aggregated tool fetches, and the
   * 60s health check kept re-dialling it indefinitely.
   *
   * No counter here: the caller has already burned its full `maxAttempts`
   * budget by the time it calls this, so the threshold is met by definition.
   * The flag self-clears — `connectMetaMcpClient` resets it on the next
   * successful connect.
   *
   * `unauthorized` separates the two failures that need completely different
   * responses. A server whose credentials were rejected cannot be fixed by
   * retrying — a human has to supply new ones — whereas an unreachable host
   * or a crashed process usually recovers by itself. Collapsing both into
   * ERROR tells the operator a server is broken but never which of those it
   * is, so it is never clear whether to wait or to act.
   */
  async recordConnectionFailure(
    serverUuid: string,
    reason: string,
    unauthorized = false,
  ): Promise<void> {
    const status = unauthorized
      ? McpServerErrorStatusEnum.enum.UNAUTHORIZED
      : McpServerErrorStatusEnum.enum.ERROR;
    logger.warn(
      `Server ${serverUuid} exhausted all connection attempts (${reason}). Marking as ${status}.`,
    );
    await this.markServerAs(serverUuid, status);
  }

  /**
   * Mark a server as ERROR
   */
  private async markServerAsError(serverUuid: string): Promise<void> {
    await this.markServerAs(serverUuid, McpServerErrorStatusEnum.enum.ERROR);
  }

  private async markServerAs(
    serverUuid: string,
    errorStatus: McpServerErrorStatus,
  ): Promise<void> {
    try {
      // Update the server-level error status
      await mcpServersRepository.updateServerErrorStatus({
        serverUuid,
        errorStatus,
      });

      logger.error(
        `Server ${serverUuid} marked as ${errorStatus} at server level`,
      );
    } catch (error) {
      logger.error(
        `Error marking server ${serverUuid} as ${errorStatus}:`,
        error,
      );
    }
  }

  /**
   * Reset crash attempts for a server (e.g., after successful recovery)
   */
  resetServerAttempts(serverUuid: string): void {
    this.crashAttempts.delete(serverUuid);
  }

  /**
   * Reset all crash attempts (e.g., on startup for a clean slate)
   */
  resetAllAttempts(): void {
    this.crashAttempts.clear();
  }

  /**
   * Get current crash attempts for a server
   */
  getServerAttempts(serverUuid: string): number {
    return this.crashAttempts.get(serverUuid) || 0;
  }

  /**
   * Check if a server is in ERROR state
   */
  async isServerInErrorState(serverUuid: string): Promise<boolean> {
    try {
      const server = await mcpServersRepository.findByUuid(serverUuid);
      return isFlaggedErrorStatus(server?.error_status);
    } catch (error) {
      logger.error(
        `Error checking server error state for ${serverUuid}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Reset error state for a server (e.g., after manual recovery)
   */
  async resetServerErrorState(serverUuid: string): Promise<void> {
    try {
      // Reset crash attempts
      this.resetServerAttempts(serverUuid);

      // Update the database to clear the error status
      await mcpServersRepository.updateServerErrorStatus({
        serverUuid,
        errorStatus: McpServerErrorStatusEnum.enum.NONE,
      });

      logger.info(`Reset error state for server ${serverUuid}`);
    } catch (error) {
      logger.error(
        `Error resetting error state for server ${serverUuid}:`,
        error,
      );
    }
  }
}

// Export singleton instance
export const serverErrorTracker = ServerErrorTracker.getInstance();
