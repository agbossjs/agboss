import { describe, expect, it } from "vitest";
import { formatLogEntry, LogLevel } from "../../src/infrastructure/logger.js";

describe("#1343: LogLevel.Debug", () => {
  it("is the fourth level, `debug`, and its line carries the code like a warning's", () => {
    expect(Object.values(LogLevel)).toEqual(["debug", "info", "warn", "error"]);
    const line = formatLogEntry({
      level: LogLevel.Debug,
      code: "app.detail",
      message: "a detail",
      time: new Date("2026-11-24T10:00:00Z"),
    });
    expect(line).toBe("10:00:00 DEBUG a detail [app.detail]");
  });
});
