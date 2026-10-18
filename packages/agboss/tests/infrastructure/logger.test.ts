/**
 * #261 PR 6 — the framework's log: the `Logger` contract (infrastructure), `ConsoleLogger` by
 * default (one line per entry on standard error), entries stamped by the application's clock, a
 * logger that throws never failing what logs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleLogger,
  formatLogEntry,
  frameworkLogOf,
  Logger,
  LogLevel,
  type LogEntry,
} from "../../src/infrastructure/logger.js";
import { VirtualClock } from "../../src/testing/clock.js";

const at = new Date("2026-01-05T15:02:11Z");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatLogEntry", () => {
  it("an info line: time, level, message", () => {
    const entry: LogEntry = {
      level: LogLevel.Info,
      code: "app.started",
      message: "Started x 1.0.0",
      time: at,
    };

    expect(formatLogEntry(entry)).toBe("15:02:11 INFO  Started x 1.0.0");
  });

  it("a problem: its code and the execution and tenant it is about, for search", () => {
    const entry: LogEntry = {
      level: LogLevel.Error,
      code: "recovery.failed",
      message: "recovery of execution e-1 failed: boom",
      time: at,
      executionId: "e-1",
      tenantId: "acme",
    };

    expect(formatLogEntry(entry)).toBe(
      "15:02:11 ERROR recovery of execution e-1 failed: boom [recovery.failed] executionId=e-1 tenantId=acme",
    );
  });
});

describe("ConsoleLogger", () => {
  it("writes one line per entry to standard error", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    new ConsoleLogger().write({ level: LogLevel.Warn, code: "x.y", message: "at risk", time: at });

    expect(write).toHaveBeenCalledWith("15:02:11 WARN  at risk [x.y]\n");
  });
});

class ThrowingLogger extends Logger {
  write(): void {
    throw new Error("disk full");
  }
}

class KeepingLogger extends Logger {
  readonly entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

describe("frameworkLogOf", () => {
  it("stamps each entry with the clock's time, the level and the ids it is given", () => {
    const logger = new KeepingLogger();
    const log = frameworkLogOf(logger, new VirtualClock());

    log.info("app.started", "Started");
    log.warn("observer.failed", "X.onAgentStart threw: bug");
    log.error("recovery.failed", "failed", { executionId: "e-1", tenantId: "acme" });

    expect(
      logger.entries.map(({ level, code, executionId, tenantId }) => ({
        level,
        code,
        executionId,
        tenantId,
      })),
    ).toEqual([
      { level: LogLevel.Info, code: "app.started", executionId: undefined, tenantId: undefined },
      {
        level: LogLevel.Warn,
        code: "observer.failed",
        executionId: undefined,
        tenantId: undefined,
      },
      { level: LogLevel.Error, code: "recovery.failed", executionId: "e-1", tenantId: "acme" },
    ]);
    expect(logger.entries[0]?.time.toISOString()).toBe("2026-01-05T09:00:00.000Z");
  });

  it("a logger that throws is ignored: the log never fails its caller", () => {
    const log = frameworkLogOf(new ThrowingLogger(), new VirtualClock());

    expect(() => {
      log.error("app.close-failed", "boom");
    }).not.toThrow();
  });
});
