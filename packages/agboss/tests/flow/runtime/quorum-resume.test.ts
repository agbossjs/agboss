import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { ApplicationStoppingError, BranchStatus, BranchVerdict } from "../../../src/index.js";
import {
  callTool,
  replyWith,
  testWith,
  type VirtualClock,
  TestConcurrency,
} from "../../../src/testing/index.js";
import type { TestApp } from "../../../src/testing/test-app.js";
import { ends, resetRecovery } from "../../infrastructure/fixtures/recovery.workflow.js";
import { seconds } from "../../../src/units/index.js";
import { execute, answerOf } from "../../helpers/flow.js";
import { ScoreDto, ScoreReviewDto } from "../fixtures/quorum-dtos.js";
import {
  ConfirmScoreTool,
  HirePanelAgent,
  PanelReviewWorkflowFinish,
  PanelSummaryAgent,
  PanelWorkflowStart,
  panel,
  resetPanel,
  textOf,
  RisksPanelAgent,
  SkillsPanelAgent,
  untilWaiting,
  WaitTool,
} from "../fixtures/quorum-runtime-parts.js";
import {
  CheckedPanelApplication,
  RecoveryPanelApplication,
} from "../fixtures/quorum-runtime.fixture.js";

/**
 * #279 PR 2 (S26) — a pause inside a quorum: the branches that finished before it keep their records
 * (the checkpoint's pending writes), so on `resume` the quorum is rebuilt from them — the same counts
 * and `acceptedSequence`, only the paused branch runs again; the deadline is kept in the launch's
 * ticket, so once it has passed the paused branch is cancelled without running.
 */

/** These tests are about the runtime's own concurrency (#262: tests default to one branch at a time). */
const REAL = { concurrency: TestConcurrency.Real };
const checked = testWith(CheckedPanelApplication, REAL);

const score = (value: number) => replyWith(ScoreDto, { score: value });
const summary = replyWith(ScoreReviewDto, { text: "summed up" });
const ANNA = { name: "Anna" };
const approve = { approved: true };

beforeEach(resetPanel);

describe("S26: a pause and a resume inside a quorum", () => {
  checked(
    "resumed before the deadline: counting goes on from the records",
    async ({ app, mockLlm, clock }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      mockLlm(RisksPanelAgent).thenReturn(callTool(ConfirmScoreTool, { score: 6 }), score(6));
      mockLlm(HirePanelAgent).thenReturn(score(9));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const paused = await execute(app, PanelWorkflowStart, ANNA);
      expect(paused.status).toBe(ExecutionStatus.Paused);
      await clock.advance(seconds(20));
      const done = await app.resume(answerOf(paused, approve));

      expect(done).toFinishWith(PanelReviewWorkflowFinish);
      expect(done.launches[0]?.branches).toMatchObject([
        { nodeId: "skills-panel-agent", verdict: BranchVerdict.Counted, acceptedSequence: 1 },
        { nodeId: "risks-panel-agent", verdict: BranchVerdict.Counted, acceptedSequence: 3 },
        { nodeId: "hire-panel-agent", verdict: BranchVerdict.Counted, acceptedSequence: 2 },
      ]);
      expect(mockLlm(SkillsPanelAgent).requests).toHaveLength(1);
      expect(mockLlm(HirePanelAgent).requests).toHaveLength(1);
      const input = textOf(mockLlm(PanelSummaryAgent).requests[0]);
      expect(input.indexOf('"score": 9')).toBeLessThan(input.indexOf('"score": 6'));
    },
  );
});

const instances = testWith(RecoveryPanelApplication, { ...REAL, instances: 2 });

const instance = (apps: readonly TestApp[], index: number): TestApp => {
  const found = apps[index];
  if (found === undefined) throw new Error(`the test runs no instance ${String(index)}`);
  return found;
};

/**
 * Starts on the first instance, stops it while the risks agent waits (its tool's 60 s), lets the
 * second recover after `afterStop` seconds; `rerun`: the risks agent's wait runs again there (its own
 * loop goes on from its checkpoint) and is let finish.
 */
async function crashAndRecover(
  apps: readonly TestApp[],
  clock: VirtualClock,
  afterStop: number,
  rerun: boolean,
): Promise<{ readonly call: Promise<unknown>; readonly recovered: unknown }> {
  for (const app of apps) await app.ready();
  const first = instance(apps, 0);
  const call = execute(first, PanelWorkflowStart, ANNA);
  call.catch(() => undefined);
  await untilWaiting(1);
  await clock.advance(seconds(5));
  const closed = first.close({ timeout: seconds(5) });
  await clock.advance(seconds(5));
  await closed;
  await clock.advance(seconds(afterStop));
  if (rerun) {
    await untilWaiting(1);
    await clock.advance(seconds(60));
  }
  const [recovered] = await ends(1);
  return { call, recovered };
}

describe("S26: a crash inside a quorum", () => {
  beforeEach(resetRecovery);

  instances(
    "after a crash the other instance runs only the unfinished branch: the same counts",
    async ({ apps, clock, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      mockLlm(RisksPanelAgent).thenReturn(callTool(WaitTool, { seconds: 60 }), score(6));
      mockLlm(HirePanelAgent).thenReturn(score(9));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const { call, recovered } = await crashAndRecover(apps, clock, 20, true);

      await expect(call).rejects.toBeInstanceOf(ApplicationStoppingError);
      expect(recovered).toMatchObject({ output: { text: "summed up" } });
      expect(panel.decided[0]?.branches).toMatchObject([
        { verdict: BranchVerdict.Counted, acceptedSequence: 1 },
        { verdict: BranchVerdict.Counted, acceptedSequence: 3 },
        { verdict: BranchVerdict.Counted, acceptedSequence: 2 },
      ]);
      expect(mockLlm(SkillsPanelAgent).requests).toHaveLength(1);
      expect(mockLlm(RisksPanelAgent).requests).toHaveLength(2);
    },
  );

  instances(
    "an expired deadlineAt cancels the unfinished branch without running it",
    async ({ apps, clock, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      // cancelled without running again after the crash: its answer never comes
      mockLlm(RisksPanelAgent).thenReturn(callTool(WaitTool, { seconds: 60 }));
      mockLlm(HirePanelAgent).thenReturn(score(9));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const { recovered } = await crashAndRecover(apps, clock, 300, false);

      expect(recovered).toMatchObject({ output: { text: "summed up" } });
      expect(panel.decided[0]?.branches).toMatchObject([
        { verdict: BranchVerdict.Counted, acceptedSequence: 1 },
        { nodeId: "risks-panel-agent", status: BranchStatus.Cancelled },
        { verdict: BranchVerdict.Counted, acceptedSequence: 2 },
      ]);
      expect(mockLlm(RisksPanelAgent).requests).toHaveLength(1);
    },
  );
});
