import { beforeEach, describe, expect } from "vitest";
import { BranchStatus, BranchVerdict, QuorumNotReachedError } from "../../../src/index.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import { seconds, usd } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { ScoreDto, ScoreReviewDto } from "../fixtures/quorum-dtos.js";
import {
  HirePanelAgent,
  panel,
  PanelFailedWorkflowFinish,
  PanelReviewWorkflowFinish,
  PanelSummaryAgent,
  PanelWorkflowStart,
  resetPanel,
  textOf,
  RisksPanelAgent,
  SkillsPanelAgent,
  untilWaiting,
  WaitTool,
} from "../fixtures/quorum-runtime-parts.js";
import {
  CheckedPanelApplication,
  QuickPanelApplication,
  StrictPanelApplication,
} from "../fixtures/quorum-runtime.fixture.js";

/**
 * #279 PR 2 — a quorum at run time (AC1, AC3, AC4, AC8): the execution goes on after `min` counted
 * answers, the rest cancelled; a quorum that can no longer be reached fails at once; only counted
 * answers reach the next step, in the order they were counted.
 */

const quick = testWith(QuickPanelApplication);
const checked = testWith(CheckedPanelApplication);
const strict = testWith(StrictPanelApplication);

const score = (value: number) => replyWith(ScoreDto, { score: value });
const slow = (value: number, wait = 60) => [callTool(WaitTool, { seconds: wait }), score(value)];
/** A branch cancelled while it waits: it never answers, so its script has no answer (#262). */
const cancelledWhileWaiting = (wait = 60) => callTool(WaitTool, { seconds: wait });
const summary = replyWith(ScoreReviewDto, { text: "summed up" });
const ANNA = { name: "Anna" };

beforeEach(resetPanel);

describe("AC1: min counted → go on, the rest cancelled", () => {
  quick(
    "two of three counted: the third is cancelled, the summary reads the two",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      mockLlm(RisksPanelAgent).thenReturn(score(6));
      mockLlm(HirePanelAgent).thenReturn(cancelledWhileWaiting());
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const result = await execute(app, PanelWorkflowStart, ANNA);

      expect(result).toFinishWith(PanelReviewWorkflowFinish, { text: "summed up" });
      expect(result.launches[0]?.branches).toMatchObject([
        {
          nodeId: "skills-panel-agent",
          status: BranchStatus.Finished,
          verdict: BranchVerdict.Counted,
        },
        {
          nodeId: "risks-panel-agent",
          status: BranchStatus.Finished,
          verdict: BranchVerdict.Counted,
        },
        { nodeId: "hire-panel-agent", status: BranchStatus.Cancelled },
      ]);
      expect(result.launches[0]?.branches[2]?.verdict).toBeUndefined();
      expect(result.launches[0]?.isQuorumReached).toBe(true);
      expect(mockLlm(HirePanelAgent).requests).toHaveLength(1);
      const input = mockLlm(PanelSummaryAgent).requests[0]?.input;
      expect(input).toContain('"score": 7');
      expect(input).toContain('"score": 6');
      expect(input).not.toContain('"score": 9');
    },
  );
});

describe("AC3: min unreachable fails at once", () => {
  checked(
    "two answers rejected: the third is not waited for, the side path is taken",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(11));
      mockLlm(RisksPanelAgent).thenReturn(score(12));
      mockLlm(HirePanelAgent).thenReturn(cancelledWhileWaiting());

      const result = await execute(app, PanelWorkflowStart, ANNA, { record: true });

      expect(result).toFinishWith(PanelFailedWorkflowFinish, ANNA);
      expect(result.launches[0]?.isQuorumReached).toBe(false);
      expect(result.launches[0]?.branches).toMatchObject([
        { verdict: BranchVerdict.Rejected, rejectedBy: ["in-range-arbiter"] },
        { verdict: BranchVerdict.Rejected, rejectedBy: ["in-range-arbiter"] },
        { status: BranchStatus.Cancelled },
      ]);
      expect(result.record?.lastError).toMatchObject({
        code: "step.quorum",
        lineage: ["step.quorum", "step.failed", "step", "agboss"],
      });
      expect(result.record?.lastError?.message).toContain("min can no longer be reached");
    },
  );
});

describe("AC4: without .onJoinError the execution fails", () => {
  strict("QuorumNotReachedError names the launching step", async ({ app, mockLlm }) => {
    mockLlm(SkillsPanelAgent).thenReturn(score(0));
    mockLlm(RisksPanelAgent).thenReturn(score(7));
    mockLlm(HirePanelAgent).thenReturn(score(42));

    const failure = execute(app, PanelWorkflowStart, ANNA);

    await expect(failure).rejects.toBeInstanceOf(QuorumNotReachedError);
    await expect(failure).rejects.toMatchObject({
      nodeId: "panel-workflow-start",
      counted: 1,
      min: 2,
    });
  });
});

describe("AC8: only counted answers enter the path scope", () => {
  checked("a rejected answer never reaches the next step", async ({ app, mockLlm }) => {
    mockLlm(SkillsPanelAgent).thenReturn(score(11));
    mockLlm(RisksPanelAgent).thenReturn(score(7));
    mockLlm(HirePanelAgent).thenReturn(score(8));
    mockLlm(PanelSummaryAgent).thenReturn(summary);

    const result = await execute(app, PanelWorkflowStart, ANNA);

    expect(result).toFinishWith(PanelReviewWorkflowFinish);
    const input = mockLlm(PanelSummaryAgent).requests[0]?.input;
    expect(input).toContain('"score": 7');
    expect(input).toContain('"score": 8');
    expect(input).not.toContain('"score": 11');
  });
});

describe("regression: the join's order and the spend", () => {
  quick(
    "the join lists the counted answers by acceptedSequence, never by listed order",
    async ({ app, mockLlm, clock }) => {
      mockLlm(SkillsPanelAgent).thenReturn(...slow(7, 5));
      mockLlm(RisksPanelAgent).thenReturn(score(6));
      mockLlm(HirePanelAgent).thenReturn(cancelledWhileWaiting());
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const execution = execute(app, PanelWorkflowStart, ANNA);
      await untilWaiting(2);
      await clock.advance(seconds(5));
      const result = await execution;

      expect(result.launches[0]?.branches).toMatchObject([
        { nodeId: "skills-panel-agent", verdict: BranchVerdict.Counted, acceptedSequence: 2 },
        { nodeId: "risks-panel-agent", verdict: BranchVerdict.Counted, acceptedSequence: 1 },
        { nodeId: "hire-panel-agent", status: BranchStatus.Cancelled },
      ]);
      const input = textOf(mockLlm(PanelSummaryAgent).requests[0]);
      expect(input.indexOf('"score": 6')).toBeLessThan(input.indexOf('"score": 7'));
    },
  );

  quick(
    "two answers for the last place at once: one counted, one surplus — both paid",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(replyWith(ScoreDto, { score: 7 }, { cost: usd(0.01) }));
      mockLlm(RisksPanelAgent).thenReturn(replyWith(ScoreDto, { score: 6 }, { cost: usd(0.02) }));
      mockLlm(HirePanelAgent).thenReturn(replyWith(ScoreDto, { score: 9 }, { cost: usd(0.04) }));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const result = await execute(app, PanelWorkflowStart, ANNA);

      const verdicts = result.launches[0]?.branches.map((branch) => branch.verdict);
      expect(verdicts).toEqual([
        BranchVerdict.Counted,
        BranchVerdict.Counted,
        BranchVerdict.Surplus,
      ]);
      expect(result.spend.totalUsd).toBeCloseTo(0.07);
      expect(mockLlm(PanelSummaryAgent).requests[0]?.input).not.toContain('"score": 9');
    },
  );

  quick("the quorum's outcome is told to observers", async ({ app, mockLlm }) => {
    mockLlm(SkillsPanelAgent).thenReturn(score(7));
    mockLlm(RisksPanelAgent).thenReturn(score(6));
    mockLlm(HirePanelAgent).thenReturn(cancelledWhileWaiting());
    mockLlm(PanelSummaryAgent).thenReturn(summary);

    const result = await execute(app, PanelWorkflowStart, ANNA);

    expect(panel.decided).toMatchObject([
      {
        executionId: result.runId,
        launch: `${result.runId}:panel-workflow-start:1`,
        isReached: true,
        step: { nodeId: "panel-workflow-start" },
        branches: [
          { verdict: BranchVerdict.Counted, acceptedSequence: 1 },
          { verdict: BranchVerdict.Counted, acceptedSequence: 2 },
          { status: BranchStatus.Cancelled },
        ],
      },
    ]);
  });
});
