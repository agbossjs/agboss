/**
 * #901 (fault s18c on PostgreSQL): a resume whose answer the holder's drain took, and whose tree a
 * cancel request then ended, never moves the ended tree. The holder still held the lease when the
 * other instance's resume recorded its answer (`Resolved`); its drain took that answer and its pass
 * stopped on the tree's cancel request before it stored a step — the pause stays `Resolved`, the
 * paused run of the rest before stays stored, and the request goes with the tree's keys at its end.
 * The waiting resume then takes the free lease and must read the tree's end, not run the answer.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import { NotPausedError, PauseStatus, type ExecutionOutput } from "../../src/index.js";
import { callTool, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { execute } from "../helpers/flow.js";
import { ExecutionCancelOutcome, executionControlOf } from "../../src/app/execution-control.js";
import { seconds } from "../../src/units/index.js";
import {
  Charge,
  Clerk,
  hooks,
  LeaseApplication,
  OrderWorkflowStart,
  resetLease,
  seen,
} from "../infrastructure/fixtures/lease.workflow.js";

const approve = { approved: true };
const THREAD = "t-901";
const test = testWith(LeaseApplication, { instances: 2 });

beforeEach(resetLease);

/** The two instances of the test (`instances: 2`). */
const pair = (apps: readonly TestApp[]): readonly [TestApp, TestApp] => {
  const [first, other] = apps;
  if (first === undefined || other === undefined) throw new Error("the test runs two instances");
  return [first, other];
};

/** Lets the event loop run until `isDone`, or fails the test. */
async function until(isDone: () => Promise<boolean>, what: string): Promise<void> {
  for (let tick = 0; tick < 1000; tick += 1) {
    if (await isDone()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`never: ${what}`);
}

describe("#901: a resume taken by the holder's drain, its tree then cancelled, moves nothing", () => {
  test("the other instance's resume reads the tree's end at its take: nothing charged, the record stays failed", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    // the only model turn: the charge, which waits for its approval (no turn after it ever runs)
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const [first, other] = pair(apps);
    const root = { id: "" };
    const resumed: { call: Promise<ExecutionOutput> | undefined } = { call: undefined };
    // the pause just saved, the first instance still holding the lease: the other answers it
    hooks.afterSave = async (paused, repository) => {
      const [pending] = paused.run.pending;
      if (resumed.call !== undefined || pending === undefined) return;
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
    // the holder's drain took that answer: before its pass moves, another instance requests the
    // tree's cancel (an A2A `CancelTask`'s `cancelExecution`): the tree runs, so it is requested
    const cancels: ExecutionCancelOutcome[] = [];
    hooks.onResume = async () => {
      delete hooks.onResume;
      const tree = { tenantId: DEFAULT_TENANT_ID, threadId: THREAD, rootExecutionId: root.id };
      const outcome = await executionControlOf(other)?.cancelExecution(tree);
      if (outcome !== undefined) cancels.push(outcome);
    };

    const moved = execute(first, OrderWorkflowStart, { text: "charge" }, { threadId: THREAD });

    // the drain's pass reads the request at its first renewal: cancelled, undone, the record failed
    await expect(moved).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(cancels).toEqual([ExecutionCancelOutcome.Requested]);
    // the waiting resume takes the lease the drain released: the tree ended, its answer runs nowhere
    await expect(resumed.call).rejects.toBeInstanceOf(NotPausedError);
    await clock.advance(seconds(31));
    expect(seen.charges).toEqual([]);
    expect(seen.completed).toEqual(["paused", "failed"]);
    const [record] = (await seen.records[0]?.lastTurns(DEFAULT_TENANT_ID, THREAD, 1)) ?? [];
    expect(record?.status).toBe("failed");
  });
});
