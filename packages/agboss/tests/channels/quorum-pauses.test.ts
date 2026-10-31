/**
 * #337 AC1: a quorum decided while a branch waits for an answer withdraws that branch's pause
 * (`Cancelled`, `PauseResolution.Withdrawn`) — the execution goes on to its join in the same call
 * instead of resting paused, nothing is left pending and a late answer gets `NotPausedError`. Decided
 * by an answer, by an answer in a later pass, by a winning group, or found decided on restore after
 * a crash (the deadline passed while no instance moved the tree).
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  ApplicationStoppingError,
  BranchStatus,
  NotPausedError,
  PauseResolution,
  PauseStatus,
} from "../../src/index.js";
import {
  callTool,
  replyWith,
  testWith,
  TestConcurrency,
  waitFor,
} from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { resetPanel, untilWaiting, WaitTool } from "../flow/fixtures/quorum-runtime-parts.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { answerFor, askFor, manager, until } from "./fixtures/pause-scripts.js";
import { pauseStore, RefundTool, resetPauses, seen } from "./fixtures/pauses.workflow.js";
import {
  FraudAgent,
  PolicyAgent,
  RefundDecidedWorkflowFinish,
  RefundGroupsWorkflowStart,
  RefundPanelApplication,
  RefundPanelWorkflowStart,
  RefundRecoveryApplication,
  RefundRecoveryWorkflowStart,
  RefundScoreDto,
  RiskAgent,
} from "./fixtures/refund-panel.workflow.js";
import { passLive } from "../helpers/live-time.js";

const test = testWith(RefundPanelApplication);
const real = testWith(RefundPanelApplication, { concurrency: TestConcurrency.Real });
const score = (value: number) => replyWith(RefundScoreDto, { score: value });
const ORDER = { orderId: "7" };

beforeEach(resetPauses);

/** The pause the desk was asked about `orderId`, as stored now. */
const storedPause = (orderId: string) =>
  pauseStore().findByTenantIdAndPauseId("default", askFor(orderId).pauseId);

describe("#337 AC1: a decided quorum withdraws its waiting branches' pauses", () => {
  test("reached while a branch waits: its pause is withdrawn, the join runs in the same call", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(PolicyAgent).thenReturn(score(7));
    mockLlm(RiskAgent).thenReturn(callTool(RefundTool, { orderId: "R" }));
    mockLlm(FraudAgent).thenReturn(score(9));

    const result = await execute(app, RefundPanelWorkflowStart, ORDER, { record: true });

    expect(result).toFinishWith(RefundDecidedWorkflowFinish, { text: "7, 9" });
    expect(result.pending).toEqual([]);
    expect(result.record?.pauses).toMatchObject([{ resolution: PauseResolution.Withdrawn }]);
    expect(result.launches[0]?.branches[1]).toMatchObject({ status: BranchStatus.Cancelled });
    expect((await storedPause("R"))?.status).toBe(PauseStatus.Cancelled);
    await expect(app.resume(answerFor("R"), manager)).rejects.toBeInstanceOf(NotPausedError);
    expect(seen.refunds).toEqual([]);
  });

  test("decided by an answer in a later pass: the other branch's pause is withdrawn then", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(PolicyAgent).thenReturn(callTool(RefundTool, { orderId: "P" }), score(7));
    mockLlm(RiskAgent).thenReturn(callTool(RefundTool, { orderId: "R" }));
    mockLlm(FraudAgent).thenReturn(score(9));
    const paused = await execute(app, RefundPanelWorkflowStart, ORDER);
    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending).toHaveLength(2);

    const done = await app.resume(answerFor("P"), manager);

    expect(done).toFinishWith(RefundDecidedWorkflowFinish, { text: "9, 7" });
    expect(done.pending).toEqual([]);
    expect((await storedPause("P"))?.status).toBe(PauseStatus.Taken);
    expect(await storedPause("R")).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Withdrawn,
    });
    expect(seen.refunds).toEqual(["P"]);
  });

  real(
    "groups: the winning group withdraws the other group's pause",
    async ({ app, clock, mockLlm }) => {
      mockLlm(PolicyAgent).thenReturn(waitFor(seconds(5)), score(7));
      mockLlm(RiskAgent).thenReturn(callTool(RefundTool, { orderId: "R" }));
      const run = execute(app, RefundGroupsWorkflowStart, ORDER, { record: true });
      await until(() => seen.asks.length === 1);

      await clock.advance(seconds(5));
      const result = await run;

      expect(result).toFinishWith(RefundDecidedWorkflowFinish, { text: "7" });
      expect(result.pending).toEqual([]);
      expect(result.record?.pauses).toMatchObject([{ resolution: PauseResolution.Withdrawn }]);
    },
  );
});

const recovery = testWith(RefundRecoveryApplication, { concurrency: TestConcurrency.Real });

describe("#337 AC1: a quorum closed by its deadline", () => {
  beforeEach(resetPanel);

  recovery(
    "the deadline passes while a branch still runs: the waiting branch's pause is withdrawn",
    async ({ app, clock, mockLlm }) => {
      mockLlm(PolicyAgent).thenReturn(score(7));
      mockLlm(RiskAgent).thenReturn(callTool(RefundTool, { orderId: "R" }));
      // still waiting at the deadline: cancelled there
      mockLlm(FraudAgent).thenReturn(callTool(WaitTool, { seconds: 600 }));
      const run = execute(app, RefundRecoveryWorkflowStart, ORDER);
      await untilWaiting(1);
      await until(() => seen.asks.length === 1);

      await passLive(clock, seconds(300));
      const result = await run;

      expect(result).toFinishWith(RefundDecidedWorkflowFinish, { text: "7" });
      expect(result.pending).toEqual([]);
      expect(await storedPause("R")).toMatchObject({ resolution: PauseResolution.Withdrawn });
    },
  );
});

const instances = testWith(RefundRecoveryApplication, {
  concurrency: TestConcurrency.Real,
  instances: 2,
});

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

describe("#337 AC1: a quorum found decided on restore", () => {
  beforeEach(() => {
    resetRecovery();
    resetPanel();
  });

  instances(
    "after a crash the deadline has passed: the other instance withdraws the waiting pause and finishes",
    async ({ apps, clock, mockLlm }) => {
      mockLlm(PolicyAgent).thenReturn(score(7));
      mockLlm(RiskAgent).thenReturn(callTool(RefundTool, { orderId: "R" }));
      // still waiting when the first instance stops; cancelled without running again
      mockLlm(FraudAgent).thenReturn(callTool(WaitTool, { seconds: 60 }));
      for (const app of apps) await app.ready();
      const first = instance(apps, 0);
      const call = execute(first, RefundRecoveryWorkflowStart, ORDER);
      call.catch(() => undefined);
      await untilWaiting(1);
      await until(() => seen.asks.length === 1);
      const closed = first.close({ timeout: seconds(5) });
      await clock.advance(seconds(5));
      await closed;

      await clock.advance(seconds(300));
      const [recovered] = await ends(1);

      await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
      expect(recovered).toMatchObject({ output: { text: "7" } });
      expect(await storedPause("R")).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Withdrawn,
      });
      expect(seen.withdrawals).toMatchObject([
        { orderId: "R", resolution: PauseResolution.Withdrawn },
      ]);
    },
  );
});
