/**
 * #1132 (the acceptance of #939 AC3): `app.cancel` of a resting tree is crash-safe across its
 * steps. The instance that cancels is killed after each write the cancel makes — the cancel
 * request, the record moved off `paused`, the paused run dropped, the root's record failed, the
 * first pause closed — and another instance, on the same SQLite file, finishes the end within a few
 * sweeps: the pause is `Cancelled`, the record `failed` as a cancel, the paused run gone, nothing
 * charged; a second `app.cancel` answers the truth. (The processes killed for real: the fault
 * suite's scenario 25.)
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { CANCELLED_STOP_REASON } from "../../src/app/live-runs.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import {
  ExecutionLeaseRepository,
  ExecutionRecordRepository,
  ExecutionTreeRepository,
  PausedExecutionRepository,
  PauseResolution,
  PauseStatus,
} from "../../src/index.js";
import { callTool, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  kill,
  levers,
  OrderWorkflowStart,
  resetRecovery,
  seen,
} from "../infrastructure/fixtures/recovery.workflow.js";
import {
  SqliteRecoveryApplication,
  sqliteFilePerTest,
} from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";

sqliteFilePerTest();
const test = testWith(SqliteRecoveryApplication, { instances: 2 });

beforeEach(resetRecovery);
/** What puts the stores the test broke back. */
const undo: (() => void)[] = [];
afterEach(() => {
  for (const restore of undo.splice(0)) restore();
});

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** The stores of an instance a death is placed in. */
const STORES = {
  leases: (app: TestApp): object => app.resolve(ExecutionLeaseRepository),
  pauses: (app: TestApp): object => app.resolve(PausedExecutionRepository),
  records: (app: TestApp): object => app.resolve(ExecutionRecordRepository),
  trees: (app: TestApp): object => app.resolve(ExecutionTreeRepository),
};

/** After which write of the instance's store the instance dies. */
interface Death {
  readonly store: keyof typeof STORES;
  readonly method: string;
  /** Which call of the method the instance dies after (1 = the first). */
  readonly nth: number;
}

/**
 * The instance dies right after the `nth` call of `method` committed: its call never returns and
 * it takes no lease from then on.
 */
function dieAfter(app: TestApp, death: Death): void {
  const target = STORES[death.store](app);
  const original: unknown = Reflect.get(target, death.method);
  if (typeof original !== "function") throw new Error(`no ${death.method}`);
  let calls = 0;
  Reflect.set(target, death.method, async (...args: unknown[]): Promise<unknown> => {
    const result: unknown = await Reflect.apply(original, target, args);
    calls += 1;
    if (calls < death.nth) return result;
    kill("instance-1");
    return new Promise<never>(() => undefined);
  });
  undo.push(() => Reflect.set(target, death.method, original));
}

/**
 * Each write `app.cancel` of a resting tree makes, in its order, with what follows a death after
 * it. `sweeps`: whether the sweeps alone end the tree (before the record moves off `paused` the
 * cancel only left its request — the tree rests until its next touch, a retry of the cancel or an
 * answer reads it, #1073). `second`: what a second cancel right after answers — `true` when it
 * ended the tree itself or handed its request to the holder that died (recovery ends it), `false`
 * when the tree was ended already.
 */
const POINTS: readonly (readonly [
  string,
  Death,
  { readonly sweeps: boolean; readonly second: boolean },
])[] = [
  [
    "the cancel mark",
    { store: "leases", method: "requestCancel", nth: 1 },
    { sweeps: false, second: true },
  ],
  [
    "the cancel request key",
    { store: "trees", method: "saveIfAbsentInTree", nth: 1 },
    { sweeps: false, second: true },
  ],
  [
    "the record moved off paused",
    { store: "records", method: "completeIfStatus", nth: 1 },
    { sweeps: true, second: true },
  ],
  [
    "the paused run dropped",
    { store: "pauses", method: "deleteByTenantIdAndThreadIdAndRunId", nth: 1 },
    { sweeps: true, second: true },
  ],
  [
    "the root's record failed",
    { store: "records", method: "completeIfStatus", nth: 2 },
    { sweeps: true, second: false },
  ],
];

/** A tree resting at its pause on the file, the instance 1 about to die in its cancel. */
async function restingTree(apps: readonly TestApp[], death: Death) {
  for (const one of apps) await one.ready();
  const first = instance(apps, 0);
  const paused = await execute(first, OrderWorkflowStart, { text: "charge" }, { threadId: "t-9" });
  const pauses = first.resolve(PausedExecutionRepository);
  const records = first.resolve(ExecutionRecordRepository);
  dieAfter(first, death);
  void first.cancel(paused.threadId).catch(() => undefined);
  await vi.waitFor(() => {
    expect(levers.dead.has("instance-1")).toBe(true);
  });
  return {
    thread: paused.threadId,
    pause: () =>
      pauses.findByTenantIdAndPauseId(DEFAULT_TENANT_ID, paused.pending[0]?.pauseId ?? ""),
    pausedRun: async () =>
      (await pauses.findByTenantIdAndThreadId(DEFAULT_TENANT_ID, paused.threadId))?.run.runId,
    record: async () => (await records.lastTurns(DEFAULT_TENANT_ID, paused.threadId, 1))[0],
  };
}

/** The tree ended as a cancel, whatever its death. */
async function expectCancelled(tree: Awaited<ReturnType<typeof restingTree>>): Promise<void> {
  expect(await tree.pause()).toMatchObject({
    status: PauseStatus.Cancelled,
    resolution: PauseResolution.Cancelled,
  });
  expect(await tree.record()).toMatchObject({
    status: "failed",
    stopReason: CANCELLED_STOP_REASON,
  });
  expect(await tree.pausedRun()).toBeUndefined();
  expect(seen.charges).toEqual([]);
}

describe("#1132 AC3: an instance that dies in the middle of app.cancel of a resting tree", () => {
  test.for(POINTS.filter(([, , { sweeps }]) => sweeps))(
    "AC3: killed after %s: within a few sweeps another instance closes the pause as cancelled; a second cancel finds nothing",
    async ([, death], { apps, clock, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
      const tree = await restingTree(apps, death);

      for (let sweep = 0; sweep < 6; sweep += 1) await clock.advance(seconds(31));

      await expectCancelled(tree);
      expect(await instance(apps, 1).cancel(tree.thread)).toEqual({ cancelled: false });
    },
  );

  test.for(POINTS)(
    "AC3: killed after %s: a second cancel right after answers the truth, and the tree ends cancelled",
    async ([, death, { second }], { apps, clock, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
      const tree = await restingTree(apps, death);

      // the dead holder's lease runs out meanwhile: the cancel waits for it, never for ever
      const answer = instance(apps, 1).cancel(tree.thread);
      for (let sweep = 0; sweep < 2; sweep += 1) await clock.advance(seconds(31));

      expect(await answer).toEqual({ cancelled: second });
      for (let sweep = 0; sweep < 6; sweep += 1) await clock.advance(seconds(31));
      await expectCancelled(tree);
    },
  );
});
