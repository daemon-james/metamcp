import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionLifetime: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./config.service", () => ({
  configService: {
    getSessionLifetime: mocks.getSessionLifetime,
  },
}));

import { SessionLifetimeManagerImpl } from "./session-lifetime-manager";

const SESSION_LIFETIME = 30 * 60 * 1000;
const T0 = new Date("2026-01-01T00:00:00.000Z");

describe("SessionLifetimeManagerImpl idle cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    mocks.getSessionLifetime.mockReset();
    mocks.getSessionLifetime.mockResolvedValue(SESSION_LIFETIME);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a recently touched session and reaps an untouched sibling", async () => {
    const manager = new SessionLifetimeManagerImpl<object>("test");
    const activeSession = { id: "active" };
    const untouchedSession = { id: "untouched" };
    manager.addSession("active", activeSession);
    manager.addSession("untouched", untouchedSession);

    vi.setSystemTime(T0.getTime() + 29 * 60 * 1000);
    manager.touchSession("active");
    vi.setSystemTime(T0.getTime() + 31 * 60 * 1000);

    const cleanup = vi.fn(async (sessionId: string) => {
      manager.removeSession(sessionId);
    });
    await manager.cleanupExpiredSessions(cleanup);

    expect(manager.getSessionIds()).toEqual(["active"]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("untouched", untouchedSession);
  });

  it("does not reap an expired session until its in-flight request ends", async () => {
    const manager = new SessionLifetimeManagerImpl<object>("test");
    const session = { id: "busy" };
    manager.addSession("busy", session);
    manager.beginRequest("busy");
    vi.setSystemTime(T0.getTime() + 31 * 60 * 1000);

    const cleanup = vi.fn(async (sessionId: string) => {
      manager.removeSession(sessionId);
    });
    await manager.cleanupExpiredSessions(cleanup);

    expect(cleanup).not.toHaveBeenCalled();
    expect(manager.getSessionIds()).toEqual(["busy"]);

    manager.endRequest("busy");
    await manager.cleanupExpiredSessions(cleanup);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith("busy", session);
    expect(manager.getSessionIds()).toEqual([]);
  });

  it("removes a timestamp that has no matching session", async () => {
    const manager = new SessionLifetimeManagerImpl<object>("test");
    const internalManager = manager as unknown as {
      sessionTimestamps: Map<string, number>;
    };
    internalManager.sessionTimestamps.set("orphan", T0.getTime());

    vi.setSystemTime(T0.getTime() + 31 * 60 * 1000);
    await manager.cleanupExpiredSessions(vi.fn());

    expect(manager.getSessionTimestamps().has("orphan")).toBe(false);
  });
});
