/**
 * #901: corners of the check a resume makes at its lease take — the root's record failed or guarded
 * means the tree is over, whatever its pauses say (the acceptance's cases):
 * - C1, a tree a real failure ended while the other instance's answer waited: that resume moves
 *   nothing, one charge in all, the record stays failed; another tree of the same pair moves on;
 * - C2, a pending pause whose root's record ended behind its back (failed / guarded): its resume
 *   is refused, nothing charged, the lease given back;
 * - C3, an ordinary resume on the other instance: finished, one charge, the record answered.
 */
import { beforeEach, describe, expect } from "vitest";
import { cancelledRecordOutcome } from "../../src/app/live-runs.js";
import { DEFAULT_TENANT_ID } from "../../src/flow/context/tenant-context.js";
import {
  ExecutionStatus,
  PauseClosedError,
  PauseStatus,
  type ExecutionOutput,
} from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { answerOf, execute } from "../helpers/flow.js";
import { seconds } from "../../src/units/index.js";
import {
  Charge,
  Clerk,
  ReceiptDto,
  hooks,
  LeaseApplication,
  OrderWorkflowStart,
  resetLease,
  seen,
} from "../infrastructure/fixtures/lease.workflow.js";

const approve = { approved: true };
const test = testWith(LeaseApplication, { instances: 2 });

beforeEach(resetLease);

const pair = (apps: readonly TestApp[]): readonly [TestApp, TestApp] => {
  const [first, other] = apps;
  if (first === undefined || other === undefined) throw new Error("the test runs two instances");
  return [first, other];
};

async function until(isDone: () => Promise<boolean>, what: string): Promise<void> {
  for (let tick = 0; tick < 1000; tick += 1) {
    if (await isDone()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`never: ${what}`);
}

describe("#901: a resume at its lease take reads whether its tree is over", () => {
  test("C1 a tree that ended by a real failure (drain's pass threw): the waiting resume -> PauseClosedError, one charge; another tree's resume unaffected", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    // one model turn only: the charge; the drain's pass, after the charge, finds the script exhausted
    mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
    const [first, other] = pair(apps);
    const resumed: { call: Promise<ExecutionOutput> | undefined } = { call: undefined };
    hooks.afterSave = async (paused, repository) => {
      const [pending] = paused.run.pending;
      if (resumed.call !== undefined || pending === undefined) return;
      const call = other.resume({ pauseId: pending.pauseId, decision: approve });
      call.catch(() => undefined);
      resumed.call = call;
      await until(async () => {
        const stored = await repository.findByTenantIdAndPauseId(
          paused.run.tenantId,
          pending.pauseId,
        );
        return stored?.status === PauseStatus.Resolved;
      }, "the other instance recorded its answer");
    };

    const moved = execute(first, OrderWorkflowStart, { text: "charge" }, { threadId: "t-c1" });
    await expect(moved).rejects.toBeDefined();
    await expect(resumed.call).rejects.toBeInstanceOf(PauseClosedError);
    await clock.advance(seconds(31));
    expect(seen.charges).toEqual(["10 USD"]);
    const [record] = (await seen.records[0]?.lastTurns(DEFAULT_TENANT_ID, "t-c1", 1)) ?? [];
    expect(record?.status).toBe("failed");

    // the lease given back: another tree pauses and resumes normally, on either instance
    delete hooks.afterSave;
    mockLlm(Clerk)
      .thenReturn(callTool(Charge, { text: "20 USD" }))
      .thenReturn(replyWith(ReceiptDto, { text: "charged 20 USD" }));
    const paused = await execute(
      other,
      OrderWorkflowStart,
      { text: "charge" },
      { threadId: "t-c1b" },
    );
    expect(paused.status).toBe(ExecutionStatus.Paused);
    const done = await first.resume(answerOf(paused, approve));
    expect(done.status).not.toBe(ExecutionStatus.Paused);
    expect(seen.charges).toEqual(["10 USD", "20 USD"]);
  });

  for (const status of ["failed", "guarded"] as const)
    test(`C2 a pending pause whose root record is ${status}: resume -> PauseClosedError, no charge, lease free`, async ({
      apps,
      mockLlm,
    }) => {
      mockLlm(Clerk)
        .thenReturn(callTool(Charge, { text: "30 USD" }))
        .thenReturn(replyWith(ReceiptDto, { text: "charged" }));
      const [first, other] = pair(apps);
      const paused = await execute(
        first,
        OrderWorkflowStart,
        { text: "charge" },
        { threadId: `t-c2-${status}` },
      );
      expect(paused.status).toBe(ExecutionStatus.Paused);
      const records = seen.records[0];
      const [record] = (await records?.lastTurns(DEFAULT_TENANT_ID, `t-c2-${status}`, 1)) ?? [];
      if (records === undefined || record === undefined) throw new Error("the pause has no record");
      expect(record.status).toBe("paused");
      // the record ended behind the pause's back (a guard, a failure another holder wrote)
      const outcome = cancelledRecordOutcome(record.route, record.costUsd);
      await records.complete(record.id, { ...outcome, status, stopReason: `#901 ${status}` });
      await expect(other.resume(answerOf(paused, approve))).rejects.toBeInstanceOf(
        PauseClosedError,
      );
      expect(seen.charges).toEqual([]);
      // lease free: a new tree on the other instance moves
      const again = await execute(
        other,
        OrderWorkflowStart,
        { text: "charge" },
        { threadId: `t-c2b-${status}` },
      );
      expect(again.status).toBe(ExecutionStatus.Finished); // the script's 2nd turn: a reply
    });

  test("C3 a normal resume on the other instance: completes, one charge, record answered", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(Clerk)
      .thenReturn(callTool(Charge, { text: "40 USD" }))
      .thenReturn(replyWith(ReceiptDto, { text: "charged 40 USD" }));
    const [first, other] = pair(apps);
    const paused = await execute(
      first,
      OrderWorkflowStart,
      { text: "charge" },
      { threadId: "t-c3" },
    );
    const done = await other.resume(answerOf(paused, approve));
    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(seen.charges).toEqual(["40 USD"]);
    const [record] = (await seen.records[0]?.lastTurns(DEFAULT_TENANT_ID, "t-c3", 1)) ?? [];
    expect(record?.status).toBe("answered");
  });
});
