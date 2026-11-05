/**
 * #799 AC1 — a store set declares the time its fencing stores decide by (`FaultStores.storeTime`),
 * and the fault suite reads the run's history on it: a set on its database's own clock is mapped at
 * 1 however fast the pods run, one on the host's clock at the pods' `timeScale`. A set without the
 * declaration — or with an unknown one — does not start its pods.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FaultStoreTime,
  FaultStoreTimeError,
  runFaultScenario,
  type FaultScenario,
} from "../../src/testing/faults/index.js";
import { storeTimeOf, storeTimeScaleOf } from "../../src/testing/faults/fault-stores.js";
import { FaultWorld } from "../../src/testing/faults/world.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";
import { sqliteFaultTarget, SQLITE_TIME_SCALE } from "./sqlite-target.js";

const moduleOf = (name: string): string =>
  fileURLToPath(new URL(`./${name}.fault-stores.ts`, import.meta.url));

/** A scenario that starts one pod and reads the facts with it: nothing ordered, nothing to break. */
const ONE_POD: FaultScenario = {
  id: "s00-one-pod",
  title: "one pod, nothing ordered",
  run: (world) => world.pod("a"),
};

describe("#799 AC1: the history is read on the time the store set declares", () => {
  it("a set on its database's clock is read at 1 while the pods run ten times faster", async () => {
    const run = await runFaultScenario(ONE_POD, sqliteFaultTarget(moduleOf("database-time")));

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
    const target = sqliteFaultTarget(moduleOf("database-time"));
    await target.database.reset?.();
    const world = new FaultWorld({ ...target, timeScale: SQLITE_TIME_SCALE });
    try {
      expect((await world.pod("a")).storeTime).toBe(FaultStoreTime.Database);
    } finally {
      await world.close();
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
    const world = new FaultWorld({ ...target, timeScale: SQLITE_TIME_SCALE });
    try {
      await expect(world.pod("a")).rejects.toThrow(/\[fault-suite\.store-time\]/u);
    } finally {
      await world.close();
    }
    await expect(runFaultScenario(ONE_POD, target)).rejects.toThrow(/\[fault-suite\.store-time\]/u);
  }, 60_000);
});
