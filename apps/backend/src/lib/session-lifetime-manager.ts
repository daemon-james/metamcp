import logger from "@/utils/logger";

import { configService } from "./config.service";

export interface SessionLifetimeManager<T> {
  addSession(sessionId: string, session: T): void;
  removeSession(sessionId: string): void;
  getSession(sessionId: string): T | undefined;
  touchSession(sessionId: string): boolean;
  beginRequest(sessionId: string): boolean;
  endRequest(sessionId: string): void;
  getAllSessions(): Map<string, T>;
  getSessionAge(sessionId: string): number | undefined;
  isSessionExpired(sessionId: string): Promise<boolean>;
  cleanupExpiredSessions(
    cleanupCallback: (sessionId: string, session: T) => Promise<void>,
  ): Promise<void>;
  startCleanupTimer(
    cleanupCallback: (sessionId: string, session: T) => Promise<void>,
    intervalMs?: number,
  ): void;
  stopCleanupTimer(): void;
}

export class SessionLifetimeManagerImpl<
  T,
> implements SessionLifetimeManager<T> {
  private sessions: Map<string, T> = new Map();
  private sessionTimestamps: Map<string, number> = new Map();
  private inFlightRequests: Map<string, number> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  addSession(sessionId: string, session: T): void {
    this.sessions.set(sessionId, session);
    this.sessionTimestamps.set(sessionId, Date.now());
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionTimestamps.delete(sessionId);
    this.inFlightRequests.delete(sessionId);
  }

  getSession(sessionId: string): T | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.touchSession(sessionId);
    }
    return session;
  }

  touchSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) {
      return false;
    }
    this.sessionTimestamps.set(sessionId, Date.now());
    return true;
  }

  beginRequest(sessionId: string): boolean {
    if (!this.touchSession(sessionId)) {
      return false;
    }
    const requestCount = this.inFlightRequests.get(sessionId) ?? 0;
    this.inFlightRequests.set(sessionId, requestCount + 1);
    return true;
  }

  endRequest(sessionId: string): void {
    const requestCount = this.inFlightRequests.get(sessionId);
    if (requestCount === undefined) {
      return;
    }
    if (requestCount <= 1) {
      this.inFlightRequests.delete(sessionId);
      return;
    }
    this.inFlightRequests.set(sessionId, requestCount - 1);
  }

  getAllSessions(): Map<string, T> {
    return new Map(this.sessions);
  }

  getSessionAge(sessionId: string): number | undefined {
    const timestamp = this.sessionTimestamps.get(sessionId);
    return timestamp === undefined ? undefined : Date.now() - timestamp;
  }

  async isSessionExpired(sessionId: string): Promise<boolean> {
    const age = this.getSessionAge(sessionId);
    if (age === undefined) return false;

    const sessionLifetime = await configService.getSessionLifetime();
    // If session lifetime is null, sessions are infinite and never expire
    if (sessionLifetime === null) return false;

    return age > sessionLifetime;
  }

  async cleanupExpiredSessions(
    cleanupCallback: (sessionId: string, session: T) => Promise<void>,
  ): Promise<void> {
    try {
      const sessionLifetime = await configService.getSessionLifetime();

      const now = Date.now();
      const expiredSessions: Array<{ sessionId: string; session: T }> = [];

      // Find expired sessions
      for (const [sessionId, timestamp] of this.sessionTimestamps.entries()) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          this.sessionTimestamps.delete(sessionId);
          this.inFlightRequests.delete(sessionId);
          continue;
        }
        if (
          sessionLifetime !== null &&
          now - timestamp > sessionLifetime &&
          !this.inFlightRequests.has(sessionId)
        ) {
          expiredSessions.push({ sessionId, session });
        }
      }

      // Clean up expired sessions
      if (expiredSessions.length > 0) {
        logger.info(
          `Cleaning up ${expiredSessions.length} expired ${this.name} sessions: ${expiredSessions.map((s) => s.sessionId).join(", ")}`,
        );

        await Promise.allSettled(
          expiredSessions.map(({ sessionId, session }) =>
            cleanupCallback(sessionId, session),
          ),
        );
      }
    } catch (error) {
      logger.error(
        `Error during automatic ${this.name} session cleanup:`,
        error,
      );
    }
  }

  startCleanupTimer(
    cleanupCallback: (sessionId: string, session: T) => Promise<void>,
    intervalMs: number = 5 * 60 * 1000, // Default: 5 minutes
  ): void {
    this.cleanupTimer = setInterval(async () => {
      await this.cleanupExpiredSessions(cleanupCallback);
    }, intervalMs);
  }

  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // Utility methods for getting session counts and IDs
  getSessionCount(): number {
    return this.sessions.size;
  }

  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  getSessionTimestamps(): Map<string, number> {
    return new Map(this.sessionTimestamps);
  }
}
