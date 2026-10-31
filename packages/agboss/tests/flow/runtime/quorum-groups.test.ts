import { beforeEach, describe, expect } from "vitest";
import { BranchStatus, BranchVerdict } from "../../../src/index.js";
import {
  callTool,
  failWith,
  ModelFailure,
  replyWith,
  testWith,
  TestConcurrency,
} from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import {
  DealCritiqueDto,
  DueDiligenceReportDto,
  FastScreenDto,
  LegalReviewDto,
} from "../fixtures/quorum-dtos.js";
import {
  CriticPanelAgent,
  DealPanelWorkflowStart,
  DealReportPanelAgent,
  DealReportPanelWorkflowFinish,
  FastPanelAgent,
  LegalPanelAgent,
  NoQuorumPanelWorkflowFinish,
  panel,
  QuickRejectPanelWorkflowFinish,
  resetPanel,
  textOf,
  SecondOpinionPanelWorkflowFinish,
  untilWaiting,
  WaitTool,
} from "../fixtures/quorum-runtime-parts.js";
import { DealPanelApplication } from "../fixtures/quorum-runtime.fixture.js";
import { passLive } from "../../helpers/live-time.js";

/**
 * #279 PR 2 — `.joinQuorumGroups(…)` at run time (AC7, AC9): group(legal, critic) priority 1 → the
 * report, group(critic) priority 2 → the second opinion, group(fast) priority 3 → the quick reject,
 * deadline 60 s. A group has arrived when all its places are counted; a lower group completing waits
 * while a higher one can still complete; the deadline takes the highest complete group; one answer
 * completing two groups gives the higher; no group able to complete fails at once. The winning group
 * continues its own path.
 */

/** These tests are about the runtime's own concurrency (#262: tests default to one branch at a time). */
const REAL = { concurrency: TestConcurrency.Real };
const deal = testWith(DealPanelApplication, REAL);

const legal = replyWith(LegalReviewDto, { risks: "none found" });
const critique = replyWith(DealCritiqueDto, { objection: "the price" });
const screen = replyWith(FastScreenDto, { rejected: true });
const report = replyWith(DueDiligenceReportDto, { text: "the report" });
const wait = (seconds: number) => callTool(WaitTool, { seconds });
const ACME = { name: "Acme" };

beforeEach(resetPanel);

describe("AC7: groups with priority", () => {
  deal(
    "a lower group complete waits while a higher can still complete",
    async ({ app, mockLlm, clock }) => {
      mockLlm(LegalPanelAgent).thenReturn(wait(10), legal);
      mockLlm(CriticPanelAgent).thenReturn(wait(5), critique);
      mockLlm(FastPanelAgent).thenReturn(screen);
      mockLlm(DealReportPanelAgent).thenReturn(report);

      const execution = execute(app, DealPanelWorkflowStart, ACME);
      await untilWaiting(2);
      await clock.advance(seconds(5)); // the critic: group 2 complete, group 1 can still complete
      await clock.advance(seconds(5)); // the legal review: group 1 complete
      const result = await execution;

      expect(result).toFinishWith(DealReportPanelWorkflowFinish, { text: "the report" });
      expect(result.launches[0]?.group).toEqual({
        agents: ["legal-panel-agent", "critic-panel-agent"],
        priority: 1,
      });
      expect(result.launches[0]?.branches).toMatchObject([
        { verdict: BranchVerdict.Counted, acceptedSequence: 3 },
        { verdict: BranchVerdict.Counted, acceptedSequence: 2 },
        { verdict: BranchVerdict.Counted, acceptedSequence: 1 },
      ]);
    },
  );

  deal("at the deadline the highest complete group is taken", async ({ app, mockLlm, clock }) => {
    mockLlm(LegalPanelAgent).thenReturn(wait(120)); // cancelled at the deadline: no answer
    mockLlm(CriticPanelAgent).thenReturn(wait(10), critique);
    mockLlm(FastPanelAgent).thenReturn(screen);

    const execution = execute(app, DealPanelWorkflowStart, ACME);
    await untilWaiting(2);
    await passLive(clock, seconds(61));
    const result = await execution;

    expect(result).toFinishWith(SecondOpinionPanelWorkflowFinish, { objection: "the price" });
    expect(result.launches[0]?.group).toEqual({ agents: ["critic-panel-agent"], priority: 2 });
    expect(result.launches[0]?.branches[0]).toMatchObject({ status: BranchStatus.Cancelled });
  });

  deal("one answer completing two groups: the higher wins", async ({ app, mockLlm, clock }) => {
    mockLlm(LegalPanelAgent).thenReturn(legal);
    mockLlm(CriticPanelAgent).thenReturn(wait(5), critique);
    mockLlm(FastPanelAgent).thenReturn(wait(60)); // cancelled once a group won: no answer
    mockLlm(DealReportPanelAgent).thenReturn(report);

    const execution = execute(app, DealPanelWorkflowStart, ACME);
    await untilWaiting(2);
    await clock.advance(seconds(5));
    const result = await execution;

    expect(result).toFinishWith(DealReportPanelWorkflowFinish);
    expect(result.launches[0]?.group?.priority).toBe(1);
    expect(result.launches[0]?.branches[2]).toMatchObject({ status: BranchStatus.Cancelled });
  });

  deal(
    "no group can complete any more: QuorumNotReachedError at once",
    async ({ app, mockLlm }) => {
      mockLlm(LegalPanelAgent).thenReturn(wait(60)); // cancelled: no group can complete
      mockLlm(CriticPanelAgent).thenReturnAlways(failWith(ModelFailure.Timeout));
      mockLlm(FastPanelAgent).thenReturnAlways(failWith(ModelFailure.Timeout));

      const result = await execute(app, DealPanelWorkflowStart, ACME, { record: true });

      expect(result).toFinishWith(NoQuorumPanelWorkflowFinish, ACME);
      expect(result.launches[0]?.branches).toMatchObject([
        { status: BranchStatus.Cancelled },
        { status: BranchStatus.Skipped, error: { code: "step.agent" } },
        { status: BranchStatus.Skipped, error: { code: "step.agent" } },
      ]);
      expect(result.record?.lastError?.message).toContain("no group can complete any more");
    },
  );
});

describe("AC9: which group won, and what was counted", () => {
  deal(
    "the winner's path and the producers; the event names the group",
    async ({ app, mockLlm }) => {
      mockLlm(LegalPanelAgent).thenReturn(legal);
      mockLlm(CriticPanelAgent).thenReturn(critique);
      mockLlm(FastPanelAgent).thenReturn(wait(60)); // cancelled once a group won: no answer
      mockLlm(DealReportPanelAgent).thenReturn(report);

      const result = await execute(app, DealPanelWorkflowStart, ACME);

      expect(result).toFinishWith(DealReportPanelWorkflowFinish);
      const input = textOf(mockLlm(DealReportPanelAgent).requests[0]);
      expect(input).toContain("(from legal-panel-agent)");
      expect(input).toContain("(from critic-panel-agent)");
      expect(panel.decided).toMatchObject([
        {
          isReached: true,
          group: { agents: ["legal-panel-agent", "critic-panel-agent"], priority: 1 },
          branches: [
            { verdict: BranchVerdict.Counted },
            { verdict: BranchVerdict.Counted },
            { status: BranchStatus.Cancelled },
          ],
        },
      ]);
    },
  );
});
