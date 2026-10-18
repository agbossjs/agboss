import { Injectable } from "../components/decorators.js";
import type { Clock } from "./clock.js";

/**
 * The framework's log (#261): infrastructure like the `Clock` — the contract `Logger`, the built-in
 * `ConsoleLogger` (one line per entry on the process's standard error), your own `extends Logger`
 * listed in `@Application({ providers })`. The framework writes little: once at start what started
 * and the worst case of one call of each start, the startup warnings, and while it runs only
 * problems of the system (`LogLevel.Warn` at risk, `LogLevel.Error` broken), each with its stable
 * `code` and the `executionId` / `tenantId` it is about, for search. One execution's details go to
 * its trace, a tenant's spend to the cost ledger, a rejected execution to the observers.
 */

/** How serious a log entry is. */
export enum LogLevel {
  /** What started (the start log). */
  Info = "info",
  /** The system is at risk: a startup warning, a recovery left to another instance. */
  Warn = "warn",
  /** Something broke: a failed recovery, a failed close, an observer that threw. */
  Error = "error",
}

/** One entry of the log: one event, one line. */
export interface LogEntry {
  readonly level: LogLevel;
  /** A stable identifier for search (`app.started`, `recovery.failed`, `observer.failed`). */
  readonly code: string;
  /** What happened, as a sentence — never a secret, never input values. */
  readonly message: string;
  /** When, from the application's `Clock`. */
  readonly time: Date;
  /** The execution it is about, when it is about one. */
  readonly executionId?: string;
  /** The tenant of that execution. */
  readonly tenantId?: string;
}

/** Where the framework's log entries go: one per application instance. */
export abstract class Logger {
  /** Writes one entry; it must not throw (a failing log never fails an execution). */
  abstract write(entry: LogEntry): void;
}

/** `15:02:11 INFO  Started job-scout-application 1.0.0 …` (+ `[code] executionId=… tenantId=…`). */
export function formatLogEntry(entry: LogEntry): string {
  const time = entry.time.toISOString().slice(11, 19);
  const level = entry.level.toUpperCase().padEnd(5);
  const ids = [
    ...(entry.level === LogLevel.Info ? [] : [`[${entry.code}]`]),
    ...(entry.executionId === undefined ? [] : [`executionId=${entry.executionId}`]),
    ...(entry.tenantId === undefined ? [] : [`tenantId=${entry.tenantId}`]),
  ];
  return [`${time} ${level} ${entry.message}`, ...ids].join(" ");
}

/** The built-in default: each entry as one line on standard error. */
@Injectable()
export class ConsoleLogger extends Logger {
  write(entry: LogEntry): void {
    process.stderr.write(`${formatLogEntry(entry)}\n`);
  }
}

/** The default of a test's application (`testWith`) that lists no logger: nothing is written. */
@Injectable()
export class SilentLogger extends Logger {
  write(): void {
    // a test reads the log through a `Logger` its application lists
  }
}

/** What an entry is about besides its text. */
export interface LogSubject {
  readonly executionId?: string | undefined;
  readonly tenantId?: string | undefined;
}

/** The framework's side of the log: entries stamped by the application's clock (internal). */
export interface FrameworkLog {
  info(code: string, message: string, subject?: LogSubject): void;
  warn(code: string, message: string, subject?: LogSubject): void;
  error(code: string, message: string, subject?: LogSubject): void;
}

/** The ids of an entry, only those it has. */
const idsOf = (subject: LogSubject): Pick<LogEntry, "executionId" | "tenantId"> => ({
  ...(subject.executionId === undefined ? {} : { executionId: subject.executionId }),
  ...(subject.tenantId === undefined ? {} : { tenantId: subject.tenantId }),
});

/** What a log message goes through before the logger (the PII policies' formats, #120 AC7). */
export type LogMask = (message: string) => string;

const unmaskedLine: LogMask = (message) => message;

/** The framework's log over a `Logger`; a logger that throws is ignored. */
export function frameworkLogOf(
  logger: Logger,
  clock: Clock,
  mask: LogMask = unmaskedLine,
): FrameworkLog {
  const write = (level: LogLevel, code: string, message: string, subject: LogSubject): void => {
    try {
      logger.write({ level, code, message: mask(message), time: clock.now(), ...idsOf(subject) });
    } catch {
      // the log is best effort: an execution never fails because its logger did
    }
  };
  return {
    info: (code, message, subject = {}) => {
      write(LogLevel.Info, code, message, subject);
    },
    warn: (code, message, subject = {}) => {
      write(LogLevel.Warn, code, message, subject);
    },
    error: (code, message, subject = {}) => {
      write(LogLevel.Error, code, message, subject);
    },
  };
}
