import { describe, expect } from "vitest";
import { BranchVerdict } from "@agboss/core";
import { decideWith, replyWith, testWith, type ModelRequest } from "@agboss/core/testing";
import { CultureScoreAgent } from "../src/panel/agents/culture-score/culture-score.agent.js";
import { HireScoreAgent } from "../src/panel/agents/hire-score/hire-score.agent.js";
import { ScoreSummaryAgent } from "../src/panel/agents/score-summary/score-summary.agent.js";
import { SkillsScoreAgent } from "../src/panel/agents/skills-score/skills-score.agent.js";
import { ReasonedScoreArbiter } from "../src/panel/arbiters/reasoned-score/reasoned-score.arbiter.js";
import { PanelReviewDto } from "../src/panel/dto/panel-review.dto.js";
import { ScoreDto } from "../src/panel/dto/score.dto.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { PanelReviewWorkflowFinish } from "../src/panel/workflows/panel/panel-review.workflow-finish.js";
import { PanelUndecidedWorkflowFinish } from "../src/panel/workflows/panel/panel-undecided.workflow-finish.js";
import { PanelWorkflowStart } from "../src/panel/workflows/panel/panel.workflow-start.js";

/** A quorum (#279): two counted scores of three are enough; the arbiters say which count. */

const test = testWith(FlowPatternsApplication);

const ANNA = { profile: "Anna, backend engineer" };
const score = (value: number, reason: string) => replyWith(ScoreDto, { score: value, reason });
const review = replyWith(PanelReviewDto, { text: "a strong candidate" });

/** The decision model accepts every reason, except one that says "no reason". */
const reasoned = (request: ModelRequest) =>
  decideWith({ counts: JSON.stringify(request.input).includes("no reason") ? 0.1 : 0.9 });

describe("a panel's quorum", () => {
  test("all three counted: the summary reads them in the order they were counted", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(SkillsScoreAgent).thenReturn(score(8, "strong in Go"));
    mockLlm(CultureScoreAgent).thenReturn(score(7, "pairs well with the team"));
    mockLlm(HireScoreAgent).thenReturn(score(8, "hire"));
    mockLlm(ReasonedScoreArbiter).thenAnswer(reasoned);
    mockLlm(ScoreSummaryAgent).thenReturn(review);

    const result = await app.execute(PanelWorkflowStart, ANNA);

    expect(result).toFinishWith(PanelReviewWorkflowFinish, { text: "a strong candidate" });
    expect(result.launches[0]?.branches.map((branch) => branch.verdict)).toEqual([
      BranchVerdict.Counted,
      BranchVerdict.Counted,
      BranchVerdict.Counted,
    ]);
  });

  test("a score out of range is rejected by code — the model is never asked about it", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(SkillsScoreAgent).thenReturn(score(11, "off the scale"));
    mockLlm(CultureScoreAgent).thenReturn(score(7, "pairs well with the team"));
    mockLlm(HireScoreAgent).thenReturn(score(6, "no reason"));
    mockLlm(ReasonedScoreArbiter).thenAnswer(reasoned);

    const result = await app.execute(PanelWorkflowStart, ANNA);

    expect(result).toFinishWith(PanelUndecidedWorkflowFinish, ANNA);
    expect(result.launches[0]?.branches).toMatchObject([
      { verdict: BranchVerdict.Rejected, rejectedBy: ["in-range-arbiter"] },
      { verdict: BranchVerdict.Counted },
      { verdict: BranchVerdict.Rejected, rejectedBy: ["reasoned-score-arbiter"] },
    ]);
    expect(mockLlm(ReasonedScoreArbiter).requests).toHaveLength(2);
  });
});
