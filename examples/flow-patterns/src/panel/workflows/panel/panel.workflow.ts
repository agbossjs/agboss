import { listOf, QuorumNotReachedError, start, toFinish, Workflow } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { CultureScoreAgent } from "../../agents/culture-score/culture-score.agent.js";
import { HireScoreAgent } from "../../agents/hire-score/hire-score.agent.js";
import { ScoreSummaryAgent } from "../../agents/score-summary/score-summary.agent.js";
import { SkillsScoreAgent } from "../../agents/skills-score/skills-score.agent.js";
import { InRangeArbiter } from "../../arbiters/in-range/in-range.arbiter.js";
import { ReasonedScoreArbiter } from "../../arbiters/reasoned-score/reasoned-score.arbiter.js";
import { CandidateDto } from "../../dto/candidate.dto.js";
import { PanelReviewDto } from "../../dto/panel-review.dto.js";
import { ScoreDto } from "../../dto/score.dto.js";
import { PanelReviewWorkflowFinish } from "./panel-review.workflow-finish.js";
import { PanelUndecidedWorkflowFinish } from "./panel-undecided.workflow-finish.js";
import { PanelWorkflowStart } from "./panel.workflow-start.js";

/**
 * A quorum (#279): three panelists score a candidate side by side; a score counts when it is in
 * range (code, cheap — first) and its reason meets its panelist's criterion (a decision model).
 * Two counted scores are enough, the third is waited for until the deadline; the rest is
 * cancelled. No quorum by then: the candidate goes to a person.
 */
@Workflow({
  name: "panel-workflow",
  version: "1.0.0",
  flow: [
    start(PanelWorkflowStart)
      .returns(CandidateDto)
      .toParallelAgents(SkillsScoreAgent, CultureScoreAgent, HireScoreAgent)
      .acceptedBy(InRangeArbiter)
      .acceptedBy(ReasonedScoreArbiter)
      .joinQuorum({ min: 2, max: 3, deadline: seconds(30) })
      .onJoinError(QuorumNotReachedError, toFinish(PanelUndecidedWorkflowFinish))
      .returns(listOf(ScoreDto))
      .toAgent(ScoreSummaryAgent)
      .returns(PanelReviewDto)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class PanelWorkflow {}
