import { beforeEach, describe, expect } from "vitest";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { ends, kill, resetRecovery, seen } from "./fixtures/recovery.workflow.js";
import {
  resetTreeLog,
  treeLog,
  untilLogged,
  type TaskDto,
} from "../flow/runtime/fixtures/tree-task.workflow.js";
import {
  ItemsWorkflowStart,
  StepCapRecoveryApplication,
} from "../app/fixtures/step-slots.workflow.js";

/**
 * #332 AC3 — the recovery sweep of an instance whose step slots are all busy
 * (`@Application({ maxConcurrentSteps: 1 })`) starts no recovery: the root a dead instance left
 * `running` goes to an idle instance, or to this one once a slot frees.
 */

const REAL = { concurrency: TestConcurrency.Real };
const two = testWith(StepCapRecoveryApplication, { ...REAL, instances: 2 });
const three = testWith(StepCapRecoveryApplication, { ...REAL, instances: 3 });

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** One task: `hold` waits until its execution stops (instant when run again), else `seconds`. */
const one = (name: string, outcome: TaskDto["outcome"], wait = 0): TaskDto[] => [
  { name, seconds: wait, outcome },
];

/** Builds the instances, then: a held root on the first (killed), a 100 s step on the second. */
async function deadAndFull(apps: readonly TestApp[]): Promise<void> {
  for (const app of apps) await app.ready();
  execute(instance(apps, 0), ItemsWorkflowStart, one("orphan", "hold")).catch(() => undefined);
  await untilLogged("start orphan");
  void execute(instance(apps, 1), ItemsWorkflowStart, one("busy", "ok", 100));
  await untilLogged("start busy");
  kill("instance-1");
}

/** Who took each root's second lease: the instance that recovered it. */
const recoveredBy = (): readonly string[] =>
  seen.leases.filter((lease) => lease.leaseEpoch === 2).map((lease) => lease.holderInstanceId);

beforeEach(() => {
  resetTreeLog();
  resetRecovery();
});

describe("AC3: a full instance leaves orphaned roots to others", () => {
  three("the idle instance recovers the root, the full one does not", async ({ apps, clock }) => {
    await deadAndFull(apps);

    await passLive(clock, seconds(31));
    const [recovered] = await ends(1);
    const events = [...treeLog.events];
    await passLive(clock, seconds(70)); // the busy step ends: nothing is left running
    await ends(2);

    expect(recoveredBy()).toEqual(["instance-3"]);
    expect(recovered?.output).toEqual({ name: "orphan" });
    expect(events).toEqual(["start orphan", "start busy", "start orphan", "end orphan"]);
  });

  three(
    "a look cut short by the free slots goes on where it stopped: every root is reached",
    async ({ apps, clock }) => {
      for (const app of apps) await app.ready();
      // instance-1 is full with a live root, listed first; instance-2 dies holding the orphan
      void execute(instance(apps, 0), ItemsWorkflowStart, one("busy", "ok", 100));
      await untilLogged("start busy");
      execute(instance(apps, 1), ItemsWorkflowStart, one("orphan", "hold")).catch(() => undefined);
      await untilLogged("start orphan");
      kill("instance-2");

      // instance-3's one free slot goes on the live root, listed first: its look stops there
      await passLive(clock, seconds(31));
      const afterFirstLook = recoveredBy();
      // the next look goes on after the live root: the orphan
      await passLive(clock, seconds(30));
      await ends(1);
      const afterSecondLook = recoveredBy();
      await passLive(clock, seconds(40));
      await ends(2);

      expect(afterFirstLook).toEqual([]);
      expect(afterSecondLook).toEqual(["instance-3"]);
      expect(treeLog.events.slice(0, 4)).toEqual([
        "start busy",
        "start orphan",
        "start orphan",
        "end orphan",
      ]);
    },
  );

  two(
    "with no idle instance, the full one recovers it once its slot frees",
    async ({ apps, clock }) => {
      await deadAndFull(apps);

      await passLive(clock, seconds(31));
      const whileFull = recoveredBy();
      await passLive(clock, seconds(70));
      await untilLogged("end busy");
      await passLive(clock, seconds(30));
      await ends(2);

      expect(whileFull).toEqual([]);
      expect(recoveredBy()).toEqual(["instance-2"]);
      expect(treeLog.events).toEqual([
        "start orphan",
        "start busy",
        "end busy",
        "start orphan",
        "end orphan",
      ]);
    },
  );
});
