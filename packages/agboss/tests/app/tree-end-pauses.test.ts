/**
 * #939 (#910 AC1, AC2): a tree's end closes its pauses. An answer the drain took whose pass a cancel
 * stopped before a step stored it is closed *not taken* — no `Resolved` pause, no stored paused run
 * — and the log says so; a tree that finishes normally changes nothing. (An answer whose step is
 * in the checkpoint is `Taken`: `tree-end-pauses-units.test.ts`.)
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import {
  PauseClosedError,
  PauseResolution,
  PauseStatus,
  type ExecutionOutput,
} from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { ExecutionCancelOutcome, executionControlOf } from "../../src/app/execution-control.js";
import { answerOf, execute } from "../helpers/flow.js";
import { seconds } from "../../src/units/index.js";
import {
  Charge,
  Clerk,
  hooks,
  LeaseApplication,
  OrderWorkflowStart,
  ReceiptDto,
  resetLease,
  seen,
  type HookedPausedExecutionRepository,
} from "../infrastructure/fixtures/lease.workflow.js";

const approve = { approved: true };
const THREAD = "t-939";
const test = testWith(LeaseApplication, { instances: 2 });

beforeEach(resetLease);

const pair = (apps: readonly TestApp[]): readonly [TestApp, TestApp] => {
  const [first, other] = apps;
  if (first === undefined || other === undefined) throw new Error("the test runs two instances");
  return [first, other];
};

/** The store a hook captured. */
function stored(
  repository: HookedPausedExecutionRepository | undefined,
): HookedPausedExecutionRepository {
  if (repository === undefined) throw new Error("the hook captured no store");
  return repository;
}

async function until(isDone: () => Promise<boolean>, what: string): Promise<void> {
  for (let tick = 0; tick < 1000; tick += 1) {
    if (await isDone()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`never: ${what}`);
}

/** What the tree left in the stores: its pauses, the thread's paused run, the answer log. */
async function leftOf(repository: HookedPausedExecutionRepository, root: string, thread: string) {
  const pauses = await repository.findAllByTenantIdAndRootExecutionId(DEFAULT_TENANT_ID, root);
  const stored = await repository.findByTenantIdAndThreadId(DEFAULT_TENANT_ID, thread);
  const log =
    (await seen.records[0]?.findPauseAnswersByTenantIdAndRootExecutionId(
      DEFAULT_TENANT_ID,
      root,
    )) ?? [];
  return { pauses, pausedRun: stored?.run.runId === root ? stored : undefined, log };
}

describe("#939 AC1: the drain took the answer, a cancel stopped the pass", () => {
  test("#910 AC1: the drain took the answer, a cancel stopped the pass — no Resolved pause, no paused run, log not taken", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const [first, other] = pair(apps);
    const root = { id: "" };
    const store: { repository?: HookedPausedExecutionRepository } = {};
    const resumed: { call: Promise<ExecutionOutput> | undefined } = { call: undefined };
    hooks.afterSave = async (paused, repository) => {
      const [pending] = paused.run.pending;
      if (resumed.call !== undefined || pending === undefined) return;
      store.repository = repository;
      const call = other.resume({ pauseId: pending.pauseId, decision: approve });
      call.catch(() => undefined);
      resumed.call = call;
      root.id = paused.run.runId;
      await until(async () => {
        const stored = await repository.findByTenantIdAndPauseId(
          paused.run.tenantId,
          pending.pauseId,
        );
        return stored?.status === PauseStatus.Resolved;
      }, "the other instance recorded its answer");
    };
    hooks.onResume = async () => {
      delete hooks.onResume;
      const tree = { tenantId: DEFAULT_TENANT_ID, threadId: THREAD, rootExecutionId: root.id };
      const outcome = await executionControlOf(other)?.cancelExecution(tree);
      expect(outcome).toBe(ExecutionCancelOutcome.Requested);
    };

    const moved = execute(first, OrderWorkflowStart, { text: "charge" }, { threadId: THREAD });

    await expect(moved).rejects.toBeInstanceOf(ExecutionCancelledError);
    await expect(resumed.call).rejects.toBeInstanceOf(PauseClosedError);
    await clock.advance(seconds(31));
    const left = await leftOf(stored(store.repository), root.id, THREAD);
    expect(seen.charges).toEqual([]);
    expect(left.pauses).toMatchObject([
      { status: PauseStatus.Cancelled, resolution: PauseResolution.Cancelled },
    ]);
    expect(left.pauses[0]?.answer?.decision).toEqual(approve);
    expect(left.pausedRun).toBeUndefined();
    expect(left.log).toMatchObject([{ isTaken: false, resolution: PauseResolution.Cancelled }]);
  });
});

describe("#939 AC2: a tree that ends normally", () => {
  test("#910 AC2: a finished tree: its Taken pause untouched, its log entry taken, no paused run", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk)
      .thenReturn(callTool(Charge, { text: "10 USD" }))
      .thenReturn(replyWith(ReceiptDto, { text: "charged" }));
    const store: { repository?: HookedPausedExecutionRepository } = {};
    hooks.afterSave = (_paused, repository) => {
      store.repository = repository;
      return Promise.resolve();
    };
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" }, { threadId: THREAD });

    const done = await app.resume(answerOf(paused, approve));

    const left = await leftOf(stored(store.repository), paused.executionId, THREAD);
    expect(done.output).toEqual({ text: "charged" });
    expect(left.pauses).toMatchObject([
      { status: PauseStatus.Taken, resolution: PauseResolution.Replied },
    ]);
    expect(left.pausedRun).toBeUndefined();
    expect(left.log).toHaveLength(1);
    expect(left.log[0]?.isTaken).not.toBe(false);
  });

  test("a cancel of a resting tree: its waiting pause is Cancelled, its paused run gone", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const store: { repository?: HookedPausedExecutionRepository } = {};
    hooks.afterSave = (_paused, repository) => {
      store.repository = repository;
      return Promise.resolve();
    };
    const paused = await execute(app, OrderWorkflowStart, { text: "charge" }, { threadId: THREAD });

    await app.cancel(THREAD);

    const left = await leftOf(stored(store.repository), paused.executionId, THREAD);
    expect(left.pauses).toMatchObject([
      { status: PauseStatus.Cancelled, resolution: PauseResolution.Cancelled },
    ]);
    expect(left.pausedRun).toBeUndefined();
  });
});
