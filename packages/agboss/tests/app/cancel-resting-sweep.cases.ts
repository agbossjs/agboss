/**
 * #1152: the cases of the sweep that ends a resting tree whose cancel died after its durable request
 * (the mark on the tree's lease row) and before the root's record moved. One body, run on the
 * in-memory stores (`cancel-resting-sweep.test.ts`) and on one SQLite file
 * (`cancel-resting-sweep.sqlite.test.ts`): two instances, the first one's cancel "died" after
 * the request, the second one's sweeps (the orphan look, every 30 s) finish it.
 */
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import type { TestAPI } from "vitest";
import { expect, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { CANCELLED_STOP_REASON } from "../../src/app/cancelled-run.js";
import {
  markUnwinding,
  unwindingMarkOf,
  UNWINDING_KEY,
} from "../../src/flow/runtime/compensation/unwinding-marks.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import {
  ExecutionLeaseRepository,
  ExecutionRecordRepository,
  ExecutionTreeRepository,
  PausedExecutionRepository,
  PauseResolution,
  PauseStatus,
} from "../../src/index.js";
import { callTool, type WorkflowFixtures } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  Charge,
  Clerk,
  Hold,
  kill,
  levers,
  OrderWorkflowStart,
  seen,
  Step,
} from "../infrastructure/fixtures/recovery.workflow.js";

const KEY = "@agboss/cancel-request";

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/** A tree resting at its pause on instance 1, with what to read of it. */
async function restingTree(apps: readonly TestApp[]) {
  for (const one of apps) await one.ready();
  const first = instance(apps, 0);
  const paused = await execute(
    first,
    OrderWorkflowStart,
    { text: "charge" },
    { threadId: "t-1152" },
  );
  const pauseId = paused.pending[0]?.pauseId ?? "";
  const pauses = first.resolve(PausedExecutionRepository);
  const records = first.resolve(ExecutionRecordRepository);
  const tree = { tenantId: DEFAULT_TENANT_ID, rootExecutionId: paused.executionId };
  return {
    pauseId,
    thread: paused.threadId,
    tree,
    /** The cancel's durable request, as `app.cancel` writes it: the mark first, then the key. */
    requests: async (app: TestApp, options: { readonly key: boolean }) => {
      await app.resolve(ExecutionLeaseRepository).requestCancel(tree);
      if (options.key)
        await app
          .resolve(ExecutionTreeRepository)
          .saveIfAbsentInTree(tree, KEY, { requestedAt: new Date(0).toISOString(), ownerId: null });
    },
    pause: () => pauses.findByTenantIdAndPauseId(DEFAULT_TENANT_ID, pauseId),
    hasPausedRun: async () =>
      (await pauses.findByTenantIdAndThreadId(DEFAULT_TENANT_ID, paused.threadId))?.run.runId ===
      paused.executionId,
    record: async () => (await records.lastTurns(DEFAULT_TENANT_ID, paused.threadId, 1))[0],
  };
}

type Resting = Awaited<ReturnType<typeof restingTree>>;

/** Sweeps of the instances: the orphan look runs once per 30 s of the test's clock. */
async function sweeps(
  clock: { advance(by: ReturnType<typeof seconds>): Promise<void> },
  count: number,
): Promise<void> {
  for (let sweep = 0; sweep < count; sweep += 1) await clock.advance(seconds(31));
}

/** Ended as `app.cancel` ends it: pause cancelled, record failed as a cancel, run gone, nothing charged. */
async function expectCancelled(tree: Resting): Promise<void> {
  expect(await tree.pause()).toMatchObject({
    status: PauseStatus.Cancelled,
    resolution: PauseResolution.Cancelled,
  });
  expect(await tree.record()).toMatchObject({
    status: "cancelled",
    stopReason: CANCELLED_STOP_REASON,
  });
  expect(await tree.hasPausedRun()).toBe(false);
  expect(seen.charges).toEqual([]);
  // the end observed once, as a cancel (`onExecutionError`)
  expect(seen.errors).toEqual([]);
  expect(seen.cancels).toHaveLength(1);
}

/** Ended as nothing: the tree still rests at its pause. */
async function expectResting(tree: Resting): Promise<void> {
  expect(await tree.pause()).toMatchObject({ status: PauseStatus.Pending });
  expect(await tree.record()).toMatchObject({ status: "paused" });
  expect(await tree.hasPausedRun()).toBe(true);
}

export function cancelRestingCases(
  test: TestAPI<WorkflowFixtures>,
  options: { readonly hasStampedRecords: boolean },
): void {
  test("a cancel that died after its mark (no key): the sweep of another instance ends the tree as app.cancel does", async ({
    apps,
    clock,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);
    await tree.requests(instance(apps, 0), { key: false });
    kill("instance-1");

    await sweeps(clock, 3);

    await expectCancelled(tree);
    expect(await instance(apps, 1).cancel(tree.thread)).toEqual({ cancelled: false });
  });

  test("a cancel that died after its mark and its key: the sweep ends the tree the same way", async ({
    apps,
    clock,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);
    await tree.requests(instance(apps, 0), { key: true });
    kill("instance-1");

    await sweeps(clock, 3);

    await expectCancelled(tree);
  });

  test("a tree with no mark is left resting by every sweep", async ({ apps, clock, mockModel }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);

    await sweeps(clock, 6);

    await expectResting(tree);
    expect(seen.errors).toEqual([]);
  });

  test("a mark of another tree does not end this one", async ({ apps, clock, mockModel }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);
    await instance(apps, 0)
      .resolve(ExecutionLeaseRepository)
      .requestCancel({ tenantId: DEFAULT_TENANT_ID, rootExecutionId: "another-tree" });

    await sweeps(clock, 6);

    await expectResting(tree);
  });

  test("the instances alive, both sweeping: the tree ends once, its end observed once", async ({
    apps,
    clock,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);
    await tree.requests(instance(apps, 1), { key: false });

    await sweeps(clock, 6);

    await expectCancelled(tree);
  });

  test("a sweep against a retried app.cancel: one end, whoever wins", async ({
    apps,
    clock,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);
    await tree.requests(instance(apps, 0), { key: false });
    kill("instance-1");

    // the retry and the sweeps start together: the cancel's own end, or the sweep's, never both
    const retried = instance(apps, 1).cancel(tree.thread);
    await sweeps(clock, 3);
    const outcome = await retried;

    expect([true, false]).toContain(outcome.cancelled);
    await expectCancelled(tree);
  });

  test("a sweep against a late answer: the answer is refused (typed) or the tree is cancelled, nothing is charged", async ({
    apps,
    clock,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);
    await tree.requests(instance(apps, 0), { key: false });
    kill("instance-1");

    const answered = instance(apps, 1).resume({
      pauseId: tree.pauseId,
      decision: { approved: true },
    });
    const settled = answered.then(
      (done: unknown) => done,
      (error: unknown) => error,
    );
    await sweeps(clock, 3);
    const refusal = await settled;

    // the answer never ran the cancelled tree: it was refused, with a typed error
    expect(
      refusal instanceof PauseError.Closed ||
        (refusal as { status?: unknown } | undefined)?.status === ExecutionStatus.Cancelled,
    ).toBe(true);
    await expectCancelled(tree);
  });

  test("a late answer after the sweep ended the tree: the typed refusal of a closed pause", async ({
    apps,
    clock,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);
    await tree.requests(instance(apps, 0), { key: false });
    kill("instance-1");
    await sweeps(clock, 3);
    await expectCancelled(tree);

    await expect(
      instance(apps, 1).resume({ pauseId: tree.pauseId, decision: { approved: true } }),
    ).rejects.toBeInstanceOf(PauseError.Closed);
    expect(seen.charges).toEqual([]);
  });

  test("a tree that a cancel ended after the sweep read it resting: the sweep takes no lease and ends nothing again", async ({
    apps,
    clock,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);
    const [first, second] = [instance(apps, 0), instance(apps, 1)];
    await tree.requests(first, { key: false });
    // whichever instance's sweep reads the record resting and the mark first, the other one's cancel
    // ends the tree right then, before that sweep takes the lease
    let isEnded = false;
    for (const [sweeper, canceller] of [
      [first, second],
      [second, first],
    ] as const) {
      const leases = sweeper.resolve(ExecutionLeaseRepository);
      // the sweep reads the lease row's marks with `markedOf` (#1341b: the cancel mark and the stop mark in one read)
      const read = leases.markedOf.bind(leases);
      vi.spyOn(leases, "markedOf").mockImplementation(async (...args) => {
        const marked = await read(...args);
        if (!isEnded) {
          isEnded = true;
          expect(await canceller.cancel(tree.thread)).toEqual({ cancelled: true });
        }
        return marked;
      });
    }
    const before = seen.leases.length;

    await sweeps(clock, 1);

    expect(isEnded).toBe(true);
    await expectCancelled(tree);
    // the cancel's own lease, and none of the sweep's
    expect(seen.leases.slice(before)).toHaveLength(1);
  });

  test("a lease held by a live instance is left alone; the sweep ends the tree once it is free", async ({
    apps,
    clock,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);
    await tree.requests(instance(apps, 0), { key: false });
    // a holder (here: a lease taken straight in the store) that never renews it
    const leases = instance(apps, 0).resolve(ExecutionLeaseRepository);
    await leases.acquire(tree.tree.tenantId, tree.tree.rootExecutionId, seconds(60));

    await clock.advance(seconds(31));
    await expectResting(tree);

    await sweeps(clock, 3);
    await expectCancelled(tree);
  });

  test("a take of the tree reads the mark itself: an answer to a tree whose cancel died after its mark is refused, nothing charged", async ({
    apps,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const tree = await restingTree(apps);
    await tree.requests(instance(apps, 0), { key: false });
    kill("instance-1");

    // no sweep ran: the answer's own take of the lease finds the cancel
    const refusal = await instance(apps, 1)
      .resume({ pauseId: tree.pauseId, decision: { approved: true } })
      .then(
        (done: unknown) => done,
        (error: unknown) => error,
      );

    expect(
      refusal instanceof PauseError.Closed ||
        (refusal as { status?: unknown } | undefined)?.status === ExecutionStatus.Cancelled,
    ).toBe(true);
    expect(seen.charges).toEqual([]);
    expect(await tree.record()).toMatchObject({
      status: "cancelled",
      stopReason: CANCELLED_STOP_REASON,
    });
  });

  const runningRoot = (title: string, hash: string | undefined): void => {
    test(title, async ({ apps, clock, mockModel }) => {
      mockModel(Clerk).thenReturn(
        callTool(Step, { text: "one" }),
        callTool(Hold, { text: "a long job" }),
      );
      for (const one of apps) await one.ready();
      const first = instance(apps, 0);
      const held = new Promise<void>((resolve) => {
        levers.holdStarted = resolve;
      });
      const call = execute(
        first,
        OrderWorkflowStart,
        { text: "step, then hold" },
        { threadId: "t-1152r" },
      );
      call.catch(() => undefined);
      await held;
      kill("instance-1");
      // the deploy that runs the sweep is not the one that started the root (S1 3: a cancel ends it on any)
      if (hash !== undefined) levers.stampedHash = hash;
      const [record] = await first
        .resolve(ExecutionRecordRepository)
        .lastTurns(DEFAULT_TENANT_ID, "t-1152r", 1);
      const rootExecutionId = record?.runId ?? "";
      await first
        .resolve(ExecutionLeaseRepository)
        .requestCancel({ tenantId: DEFAULT_TENANT_ID, rootExecutionId });

      await sweeps(clock, 3);

      expect(seen.errors).toEqual([]);
      expect(seen.cancels).toHaveLength(1);
      expect(seen.resumes).toEqual([]);
      expect(seen.holds).toHaveLength(1);
      const [ended] = await first
        .resolve(ExecutionRecordRepository)
        .lastTurns(DEFAULT_TENANT_ID, "t-1152r", 1);
      expect(ended).toMatchObject({ status: "cancelled", stopReason: CANCELLED_STOP_REASON });
    });
  };

  runningRoot(
    "a running root whose holder died after the cancel's mark (no key): recovery ends it as cancelled",
    undefined,
  );
  if (options.hasStampedRecords)
    runningRoot(
      "the same root started under another config: the sweep ends it as cancelled, on any version",
      "a-config-of-another-deploy",
    );

  test("a running root whose automatic undo was under way (no cancel, no mark) is finished by the recovery sweep, as the undo's own cause", async ({
    apps,
    clock,
    mockModel,
  }) => {
    mockModel(Clerk).thenReturn(
      callTool(Step, { text: "one" }),
      callTool(Hold, { text: "a long job" }),
    );
    for (const one of apps) await one.ready();
    const first = instance(apps, 0);
    const held = new Promise<void>((resolve) => {
      levers.holdStarted = resolve;
    });
    const call = execute(
      first,
      OrderWorkflowStart,
      { text: "step, then hold" },
      { threadId: "t-1152u" },
    );
    call.catch(() => undefined);
    await held;
    kill("instance-1");
    const [record] = await first
      .resolve(ExecutionRecordRepository)
      .lastTurns(DEFAULT_TENANT_ID, "t-1152u", 1);
    const tree = { tenantId: DEFAULT_TENANT_ID, rootExecutionId: record?.runId ?? "" };
    // the holder died after it marked its tree's undo under way (#340 PR 4), for a failure
    await markUnwinding(
      { trees: first.resolve(ExecutionTreeRepository), tree, key: UNWINDING_KEY },
      unwindingMarkOf(new Error("the pass failed")),
    );

    await sweeps(clock, 3);

    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]).not.toBeInstanceOf(ExecutionCancelledError);
    expect(seen.resumes).toEqual([]);
    const [ended] = await first
      .resolve(ExecutionRecordRepository)
      .lastTurns(DEFAULT_TENANT_ID, "t-1152u", 1);
    expect(ended).toMatchObject({ status: "failed" });
    expect(ended?.stopReason).not.toBe(CANCELLED_STOP_REASON);
  });
}
