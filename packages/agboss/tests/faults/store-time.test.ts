/**
 * #799 AC1 — a store set declares the time its fencing stores decide by (`FaultStoreSet.storeTime`),
 * and the fault suite reads the run's history on it: a set on its database's own clock is mapped at
 * 1 however fast the pods run, one on the host's clock at the pods' `timeScale`. A set without the
 * declaration — or with an unknown one — does not start its pods.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FaultStoreTime } from "../../src/testing/faults/index.js";
import { FaultStoreTimeError } from "../../src/testing/faults/fault-stores.js";
import { runFaultScenario, type RunnableFaultScenario } from "../../src/testing/faults/scenario.js";
import { storeTimeOf, storeTimeScaleOf } from "../../src/testing/faults/fault-stores.js";
import {
  FaultStoreTimeMismatchError,
  checkStoreTime,
  isClockProbeKey,
  probeWaitOf,
} from "../../src/testing/faults/store-clock-probe.js";
import { FaultCluster } from "../../src/testing/faults/cluster.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";
import { sqliteFaultTarget, SQLITE_TIME_SCALE } from "./sqlite-target.js";

const moduleOf = (name: string): string =>
  fileURLToPath(new URL(`./${name}.fault-stores.ts`, import.meta.url));

/** A scenario that starts one pod and reads the facts with it: nothing ordered, nothing to break. */
const ONE_POD: RunnableFaultScenario = {
  id: "s00-one-pod",
  title: "one pod, nothing ordered",
  run: (cluster) => cluster.pod("a"),
};

describe("#799 AC1: the history is read on the time the store set declares", () => {
  it("a set on its database's clock is read at 1 while the pods run ten times faster", async () => {
    const run = await runFaultScenario(ONE_POD, sqliteFaultTarget(moduleOf("real-clock-database")));

    expect(run.timeScale).toBe(1);
  }, 60_000);

  it("a set on the host's clock is read at the pods' timeScale", async () => {
    const run = await runFaultScenario(ONE_POD, sqliteFaultTarget());

    expect(run.timeScale).toBe(SQLITE_TIME_SCALE);
  }, 60_000);

  it("the scale of each store time", () => {
    expect(storeTimeScaleOf(FaultStoreTime.Database, 5)).toBe(1);
    expect(storeTimeScaleOf(FaultStoreTime.Host, 5)).toBe(5);
  });

  it("a pod reports the set's declaration", async () => {
    const target = sqliteFaultTarget(moduleOf("real-clock-database"));
    await target.database.reset?.();
    const cluster = new FaultCluster({ ...target, timeScale: SQLITE_TIME_SCALE });
    try {
      expect((await cluster.pod("a")).storeTime).toBe(FaultStoreTime.Database);
    } finally {
      await cluster.close();
    }
  }, 60_000);
});

describe("#959 AC1: a declaration the store's clock contradicts fails the suite, named", () => {
  it.each([
    [
      "Database on stores that read the pods' clock",
      "database-time",
      /declares storeTime "database".*but of "host" \(10x\)/u,
    ],
    [
      "Host on a store that reads the real clock",
      "real-clock",
      /declares storeTime "host".*but of "database" \(1x\)/u,
    ],
  ])(
    "%s: [fault-suite.store-time-mismatch], and no scenario runs",
    async (_case, module, why) => {
      const target = sqliteFaultTarget(moduleOf(module));

      const failure = await runFaultScenario(ONE_POD, target).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FaultStoreTimeMismatchError);
      expect((failure as Error).message).toMatch(/^\[fault-suite\.store-time-mismatch\] /u);
      expect((failure as Error).message).toMatch(why);
    },
    60_000,
  );

  it("a rate nearer the declared one passes, a rate nearer the other fails", () => {
    const check = (declared: FaultStoreTime, storeMs: number, timeScale = 10): void => {
      checkStoreTime(declared, { storeMs, realMs: 300 }, timeScale);
    };

    expect(() => {
      check(FaultStoreTime.Host, 2900);
      check(FaultStoreTime.Database, 310);
    }).not.toThrow();
    for (const [declared, storeMs] of [
      [FaultStoreTime.Host, 310],
      [FaultStoreTime.Database, 2900],
      [FaultStoreTime.Host, 0],
    ] as const)
      expect(() => {
        check(declared, storeMs);
      }).toThrow(/store-time-mismatch/u);
  });

  it("at the real clock the two times are one rate: nothing to contradict", () => {
    expect(() => {
      checkStoreTime(FaultStoreTime.Host, { storeMs: 300, realMs: 300 }, 1);
      checkStoreTime(FaultStoreTime.Database, { storeMs: 300, realMs: 300 }, 1);
    }).not.toThrow();
  });

  it("the probe waits longer the nearer the two rates are", () => {
    expect(probeWaitOf(1)).toBe(0);
    expect(probeWaitOf(10)).toBe(300);
    expect(probeWaitOf(1.2)).toBeCloseTo(1000, -1);
    expect(probeWaitOf(1.01)).toBe(3000);
  });

  it("the probe's leases are no part of the run's history", async () => {
    const target = sqliteFaultTarget(moduleOf("real-clock-database"));
    await target.database.reset?.();
    const cluster = new FaultCluster({ ...target, timeScale: SQLITE_TIME_SCALE });
    try {
      await cluster.pod("a");
      expect(cluster.history.events.filter((event) => isClockProbeKey(event.key))).toEqual([]);
    } finally {
      await cluster.close();
    }
  }, 60_000);
});

describe("#799 AC1: a set that does not declare its store time is refused", () => {
  it.each([
    ["none", undefined],
    ["an unknown one", "wall-clock"],
  ])("%s: FaultStoreTimeError, naming both choices", (_case, storeTime) => {
    const error: unknown = (() => {
      try {
        return storeTimeOf({ ...sqlite, storeTime: storeTime as FaultStoreTime });
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(FaultStoreTimeError);
    expect((error as Error).message).toMatch(
      /^\[fault-suite\.store-time\] the store set's storeTime is .*FaultStoreTime\.Database .*FaultStoreTime\.Host/u,
    );
  });

  it("its pod does not start, with the refusal; so the scenario fails", async () => {
    const target = sqliteFaultTarget(moduleOf("no-store-time"));
    await target.database.reset?.();
    const cluster = new FaultCluster({ ...target, timeScale: SQLITE_TIME_SCALE });
    try {
      await expect(cluster.pod("a")).rejects.toThrow(/\[fault-suite\.store-time\]/u);
    } finally {
      await cluster.close();
    }
    await expect(runFaultScenario(ONE_POD, target)).rejects.toThrow(/\[fault-suite\.store-time\]/u);
  }, 60_000);
});
