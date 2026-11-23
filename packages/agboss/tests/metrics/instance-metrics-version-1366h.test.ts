/**
 * #1366: the meter's version is the framework package's `version` when that is a string, else "unknown"
 * (a package.json that is not an object, has no version, or a non-string one never breaks the metrics).
 */
import { describe, expect, it, vi } from "vitest";

const pkg = vi.hoisted(() => ({ value: undefined }));
vi.mock("../../src/package-json.js", () => ({ frameworkPackageJson: () => pkg.value }));

import { InstanceMetrics, METER_NAME } from "../../src/metrics/instance-metrics.js";
import { instanceMeter } from "./support/metric-reader.js";

async function versionWith(value: unknown): Promise<string | undefined> {
  pkg.value = value;
  const meter = instanceMeter();
  const m = new InstanceMetrics({
    meterProvider: meter.provider,
    queue: { countByStatus: () => Promise.resolve({ queued: 0, running: 0 }) } as never,
    pauses: { countNotices: () => Promise.resolve({ live: 0, dead: 0 }) },
    clock: { now: () => new Date(0) } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const { resourceMetrics } = await meter.reader.collect();
  m.onDestroy();
  return resourceMetrics.scopeMetrics.find((s) => s.scope.name === METER_NAME)?.scope.version;
}

describe("#1366: the meter's version", () => {
  it("is the package's string version", async () => {
    expect(await versionWith({ version: "9.8.7" })).toBe("9.8.7");
  });

  it("is unknown when the package.json states none usable", async () => {
    for (const value of [{}, null, "str", 5, { version: 5 }, { version: null }, undefined]) {
      expect(await versionWith(value)).toBe("unknown");
    }
  });
});
