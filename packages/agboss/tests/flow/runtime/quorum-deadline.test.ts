import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { BranchStatus, BranchVerdict } from "../../../src/index.js";
import { callTool, replyWith, testWith, TestConcurrency } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { execute, answerOf } from "../../helpers/flow.js";
import { ScoreDto, ScoreReviewDto } from "../fixtures/quorum-dtos.js";
import {
  ConfirmScoreTool,
  HirePanelAgent,
  PanelFailedWorkflowFinish,
  PanelReviewWorkflowFinish,
  PanelSummaryAgent,
  PanelWorkflowStart,
  resetPanel,
  RisksPanelAgent,
  SkillsPanelAgent,
  untilChecked,
  untilWaiting,
  WaitTool,
} from "../fixtures/quorum-runtime-parts.js";
import { CheckedPanelApplication } from "../fixtures/quorum-runtime.fixture.js";
import { passLive } from "../../helpers/live-time.js";

/**
 * #279 PR 2 — `.joinQuorum({ min: 2, max: 3, deadline: seconds(30) })` on the test's virtual clock
 * (AC2, AC10, AC12): between `min` and `max` the join waits until `max`, every branch through, or
 * the deadline; at the deadline `min` reached goes on, else `QuorumNotReachedError`; an answer still
 * being checked does not count; a pause counts as elapsed time.
 */

/** These tests are about the runtime's own concurrency (#262: tests default to one branch at a time). */
const REAL = { concurrency: TestConcurrency.Real };
const checked = testWith(CheckedPanelApplication, REAL);

const score = (value: number) => replyWith(ScoreDto, { score: value });
const slow = (value: number, wait: number) => [callTool(WaitTool, { seconds: wait }), score(value)];
/** A branch cancelled while it waits: it never answers, so its script has no answer (#262). */
const cancelledWhileWaiting = (wait: number) => callTool(WaitTool, { seconds: wait });
const summary = replyWith(ScoreReviewDto, { text: "summed up" });
const ANNA = { name: "Anna" };
const approve = { approved: true };

beforeEach(resetPanel);

describe("AC2: between min and max, the deadline", () => {
  checked(
    "between min and max: it waits for the third, which comes before the deadline",
    async ({ app, mockLlm, clock }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      mockLlm(RisksPanelAgent).thenReturn(score(6));
      mockLlm(HirePanelAgent).thenReturn(...slow(9, 10));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const execution = execute(app, PanelWorkflowStart, ANNA);
      await untilWaiting(1);
      await clock.advance(seconds(10));
      const result = await execution;

      expect(result).toFinishWith(PanelReviewWorkflowFinish);
      const verdicts = result.launches[0]?.branches.map((branch) => branch.verdict);
      expect(verdicts).toEqual([
        BranchVerdict.Counted,
        BranchVerdict.Counted,
        BranchVerdict.Counted,
      ]);
      expect(mockLlm(PanelSummaryAgent).requests[0]?.input).toContain('"score": 9');
    },
  );

  checked(
    "the deadline with min reached: it goes on with the two, the third cancelled",
    async ({ app, mockLlm, clock }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      mockLlm(RisksPanelAgent).thenReturn(score(6));
      mockLlm(HirePanelAgent).thenReturn(cancelledWhileWaiting(60));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const execution = execute(app, PanelWorkflowStart, ANNA);
      await untilWaiting(1);
      await passLive(clock, seconds(31));
      const result = await execution;

      expect(result).toFinishWith(PanelReviewWorkflowFinish);
      expect(result.launches[0]?.branches).toMatchObject([
        { verdict: BranchVerdict.Counted },
        { verdict: BranchVerdict.Counted },
        { nodeId: "hire-panel-agent", status: BranchStatus.Cancelled },
      ]);
      expect(mockLlm(HirePanelAgent).requests).toHaveLength(1);
    },
  );

  checked(
    "the deadline with min not reached: QuorumNotReachedError into .onJoinError",
    async ({ app, mockLlm, clock }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      mockLlm(RisksPanelAgent).thenReturn(cancelledWhileWaiting(60));
      mockLlm(HirePanelAgent).thenReturn(cancelledWhileWaiting(60));

      const execution = execute(app, PanelWorkflowStart, ANNA, { record: true });
      await untilWaiting(2);
      await clock.advance(seconds(29));
      expect(clock.now().toISOString()).toBe("2026-01-05T09:00:29.000Z");
      await clock.advance(seconds(2));
      const result = await execution;

      expect(result).toFinishWith(PanelFailedWorkflowFinish, ANNA);
      expect(result.record?.lastError).toMatchObject({ code: "step.quorum" });
      expect(result.record?.lastError?.message).toContain(
        "1 counted, need 2 — the deadline passed",
      );
    },
  );

  checked(
    "an answer still being checked at the deadline does not count",
    async ({ app, mockLlm, clock }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      mockLlm(RisksPanelAgent).thenReturn(score(6));
      mockLlm(HirePanelAgent).thenReturn(score(99)); // its check waits for a gate never opened
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const execution = execute(app, PanelWorkflowStart, ANNA);
      await untilChecked("in-range hire 99");
      await passLive(clock, seconds(31));
      const result = await execution;

      expect(result).toFinishWith(PanelReviewWorkflowFinish);
      expect(result.launches[0]?.branches[2]).toMatchObject({ status: BranchStatus.Cancelled });
      expect(mockLlm(PanelSummaryAgent).requests[0]?.input).not.toContain('"score": 99');
    },
  );
});

describe("AC10: the deadline counts real time, pauses included", () => {
  checked(
    "the deadline passes during a pause: the paused branch is cancelled without running",
    async ({ app, mockLlm, clock }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      // cancelled at its pause: the answer after the confirmation never comes
      mockLlm(RisksPanelAgent).thenReturn(callTool(ConfirmScoreTool, { score: 6 }));
      mockLlm(HirePanelAgent).thenReturn(score(9));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const paused = await execute(app, PanelWorkflowStart, ANNA);
      expect(paused.status).toBe(ExecutionStatus.Paused);
      await passLive(clock, seconds(31));
      const done = await app.resume(answerOf(paused, approve));

      expect(done).toFinishWith(PanelReviewWorkflowFinish);
      expect(done.launches[0]?.branches).toMatchObject([
        { verdict: BranchVerdict.Counted, acceptedSequence: 1 },
        { nodeId: "risks-panel-agent", status: BranchStatus.Cancelled },
        { verdict: BranchVerdict.Counted, acceptedSequence: 2 },
      ]);
      expect(mockLlm(RisksPanelAgent).requests).toHaveLength(1);
    },
  );
});
