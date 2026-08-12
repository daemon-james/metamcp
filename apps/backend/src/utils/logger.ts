import { appendFileSync, renameSync, statSync, writeFileSync } from "fs";
import { format } from "util";

const { LOG_LEVEL, LOG_MAX_BYTES, LOG_MAX_BACKUPS } = process.env;

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

// Severities are ordered so a configured level acts as a *threshold*: every
// message at or above it is emitted.
//
// The previous implementation treated the level as an exact-match filter, so
// LOG_LEVEL=info mirrored INFO and nothing else — warnings and errors were
// written to the log files and silently dropped from stdout. A container
// running at the most ordinary setting imaginable therefore produced a
// completely clean `docker logs` while failing continuously. No logging
// library behaves that way, and nobody reading `LOG_LEVEL=info` expects it to
// hide errors.
const SEVERITY: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

// Accepted values, mapped to a threshold. The legacy spellings are kept so
// existing deployments keep working; "all" and "errors-only" mean what they
// always did, "info" now means "info and above" as it should always have.
const LEVEL_THRESHOLDS = {
  all: SEVERITY.DEBUG,
  debug: SEVERITY.DEBUG,
  info: SEVERITY.INFO,
  warn: SEVERITY.WARN,
  "errors-only": SEVERITY.WARN,
  error: SEVERITY.ERROR,
  none: Number.POSITIVE_INFINITY,
} as const;

export type ValidLogLevel = keyof typeof LEVEL_THRESHOLDS;

const DEFAULT_LEVEL: ValidLogLevel = "errors-only";

export const resolveLogLevel = (level: string | undefined): ValidLogLevel => {
  if (!level) return DEFAULT_LEVEL;
  const normalized = level.trim().toLowerCase();
  return normalized in LEVEL_THRESHOLDS
    ? (normalized as ValidLogLevel)
    : DEFAULT_LEVEL;
};

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// 10 MB per file, 3 generations kept. The log files live on the container
// filesystem, so before rotation existed they grew without limit for the
// lifetime of the container — 2.5 MB in ten hours on a fifteen-server
// deployment — and took the entire forensic trail with them on recreate.
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 3;

export interface LoggerOptions {
  logFilePath?: string;
  errorFilePath?: string;
  shouldConsoleLog?: boolean | ValidLogLevel;
  maxBytes?: number;
  maxBackups?: number;
}

// Writes are synchronous by design. A WriteStream buffers, which makes the
// byte count an estimate of what is *queued* rather than what is *on disk*,
// and size-based rotation then renames files that the pending buffer has not
// reached yet — shuffling empty generations around while the real output
// accumulates in whatever file happens to be current. At this logger's volume
// (a few hundred bytes per event, well under one event per second in a
// fifteen-server deployment) a synchronous append costs microseconds and makes
// both the accounting and the rotation exact.
interface RotatingFile {
  path: string;
  written: number;
}

export class Logger {
  public static readonly defaultLogFilePath = "app.log";
  public static readonly defaultErrorFilePath = "error.log";

  private logFile: RotatingFile;
  private errorFile: RotatingFile;
  private threshold: number;
  private readonly maxBytes: number;
  private readonly maxBackups: number;

  constructor(options: LoggerOptions = {}) {
    const {
      logFilePath = Logger.defaultLogFilePath,
      errorFilePath = Logger.defaultErrorFilePath,
      shouldConsoleLog = "all",
      maxBytes = parsePositiveInt(LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
      maxBackups = parsePositiveInt(LOG_MAX_BACKUPS, DEFAULT_MAX_BACKUPS),
    } = options;

    this.maxBytes = maxBytes;
    this.maxBackups = maxBackups;

    this.logFile = this.openFile(logFilePath);
    this.errorFile = this.openFile(errorFilePath);

    const level =
      typeof shouldConsoleLog === "boolean"
        ? shouldConsoleLog
          ? "all"
          : "none"
        : shouldConsoleLog;
    this.threshold = LEVEL_THRESHOLDS[level] ?? LEVEL_THRESHOLDS[DEFAULT_LEVEL];
  }

  private openFile(path: string): RotatingFile {
    let written = 0;
    try {
      // Pick up where a previous process left off so a restart cannot bypass
      // the size cap by resetting the counter to zero.
      writeFileSync(path, "", { flag: "a" });
      written = statSync(path).size;
    } catch {
      // Unwritable path — writes below will throw and are swallowed there.
    }
    return { path, written };
  }

  // Size-based rotation: app.log → app.log.1 → app.log.2 → ... Renaming is
  // synchronous so a burst of writes cannot interleave with a half-finished
  // rotation and split a line across two files.
  private rotateIfNeeded(file: RotatingFile, incoming: number): void {
    if (file.written + incoming <= this.maxBytes) return;

    try {
      for (let i = this.maxBackups - 1; i >= 1; i--) {
        try {
          renameSync(`${file.path}.${i}`, `${file.path}.${i + 1}`);
        } catch {
          // That generation does not exist yet.
        }
      }
      renameSync(file.path, `${file.path}.1`);
    } catch {
      // If rotation fails (read-only mount, permissions) keep logging to the
      // existing path rather than losing the messages entirely.
    }

    file.written = 0;
  }

  private formatDate(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");

    return (
      `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} - ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  private customLog(file: RotatingFile, level: LogLevel, ...args: unknown[]) {
    const logMessage = format(...(args as unknown[]));
    const formattedMessage = `[${level}] ${this.formatDate(new Date())} | ${logMessage}\n`;
    const size = Buffer.byteLength(formattedMessage);

    this.rotateIfNeeded(file, size);
    try {
      appendFileSync(file.path, formattedMessage);
      file.written += size;
    } catch {
      // Never let a logging failure take down the caller. The console mirror
      // below still runs, so the message is not necessarily lost.
    }

    if (SEVERITY[level] >= this.threshold) {
      const trimmed = formattedMessage.trim();
      if (level === "INFO") {
        console.info(trimmed);
      } else if (level === "ERROR") {
        console.error(trimmed);
      } else if (level === "WARN") {
        console.warn(trimmed);
      } else {
        console.log(trimmed);
      }
    }
  }

  public debug = (...args: unknown[]) =>
    this.customLog(this.logFile, "DEBUG", ...args);
  public info = (...args: unknown[]) =>
    this.customLog(this.logFile, "INFO", ...args);
  public warn = (...args: unknown[]) =>
    this.customLog(this.logFile, "WARN", ...args);
  public error = (...args: unknown[]) =>
    this.customLog(this.errorFile, "ERROR", ...args);

  // Nothing to flush — every write already reached disk before returning.
  // Kept so callers have an explicit shutdown hook, and async so the contract
  // survives if buffering is ever reintroduced.
  public close(): Promise<void> {
    return Promise.resolve();
  }
}

const logger = new Logger({
  shouldConsoleLog: resolveLogLevel(LOG_LEVEL),
});

export default logger;
