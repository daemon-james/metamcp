import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Logger, resolveLogLevel } from "./logger";

describe("resolveLogLevel", () => {
  it("accepts every documented spelling", () => {
    for (const level of [
      "all",
      "debug",
      "info",
      "warn",
      "errors-only",
      "error",
      "none",
    ]) {
      expect(resolveLogLevel(level)).toBe(level);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveLogLevel("  INFO ")).toBe("info");
  });

  it("falls back to errors-only for unset or unrecognised values", () => {
    expect(resolveLogLevel(undefined)).toBe("errors-only");
    expect(resolveLogLevel("")).toBe("errors-only");
    expect(resolveLogLevel("verbose")).toBe("errors-only");
  });
});

describe("Logger console thresholds", () => {
  let dir: string;
  let spies: Record<string, ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "metamcp-logger-"));
    spies = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeLogger = (level: Parameters<typeof resolveLogLevel>[0]) =>
    new Logger({
      logFilePath: join(dir, "app.log"),
      errorFilePath: join(dir, "error.log"),
      shouldConsoleLog: resolveLogLevel(level),
    });

  const emitAll = (logger: Logger) => {
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
  };

  // The regression this whole rewrite exists for: a level names a threshold,
  // so "info" must not swallow warnings and errors.
  it("info emits info, warn and error — not just info", () => {
    emitAll(makeLogger("info"));
    expect(spies.info).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
    expect(spies.log).not.toHaveBeenCalled();
  });

  it("all emits every level including debug", () => {
    emitAll(makeLogger("all"));
    expect(spies.log).toHaveBeenCalledTimes(1);
    expect(spies.info).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
  });

  it("errors-only keeps its historical meaning of warn and above", () => {
    emitAll(makeLogger("errors-only"));
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
  });

  it("error emits only errors", () => {
    emitAll(makeLogger("error"));
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledTimes(1);
  });

  it("none emits nothing", () => {
    emitAll(makeLogger("none"));
    for (const spy of Object.values(spies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  // Console level and file persistence are independent: everything is always
  // written to disk regardless of what is mirrored to stdout.
  it("writes every level to file even when the console is silent", async () => {
    const logger = makeLogger("none");
    emitAll(logger);
    await logger.close();
    const app = readFileSync(join(dir, "app.log"), "utf8");
    expect(app).toContain("[DEBUG]");
    expect(app).toContain("[INFO]");
    expect(app).toContain("[WARN]");
    expect(readFileSync(join(dir, "error.log"), "utf8")).toContain("[ERROR]");
  });
});

describe("Logger rotation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "metamcp-rotate-"));
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rotates once the size cap is exceeded and keeps generations", async () => {
    const logPath = join(dir, "app.log");
    const logger = new Logger({
      logFilePath: logPath,
      errorFilePath: join(dir, "error.log"),
      shouldConsoleLog: "none",
      maxBytes: 200,
      maxBackups: 2,
    });

    for (let i = 0; i < 12; i++) {
      logger.info(`message ${i} ${"x".repeat(40)}`);
    }
    await logger.close();

    expect(readFileSync(`${logPath}.1`, "utf8").length).toBeGreaterThan(0);
    expect(readFileSync(logPath, "utf8").length).toBeLessThanOrEqual(400);
    // maxBackups=2 means .1 and .2 exist; .3 must never be created.
    expect(() => readFileSync(`${logPath}.3`, "utf8")).toThrow();
  });

  it("counts pre-existing file size so a restart cannot bypass the cap", async () => {
    const logPath = join(dir, "app.log");
    writeFileSync(logPath, "y".repeat(500));

    const logger = new Logger({
      logFilePath: logPath,
      errorFilePath: join(dir, "error.log"),
      shouldConsoleLog: "none",
      maxBytes: 200,
      maxBackups: 2,
    });
    logger.info("first line after restart");
    await logger.close();

    // The oversized pre-existing file was rotated out rather than appended to.
    expect(readFileSync(`${logPath}.1`, "utf8")).toContain("y".repeat(500));
    expect(readFileSync(logPath, "utf8")).toContain("first line after restart");
  });
});
