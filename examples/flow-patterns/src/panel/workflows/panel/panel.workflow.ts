import { StepError } from "@agboss/core";
import { onStart, toAgent, toFinish, Workflow, Ttl } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { CultureScoreAgent } from "../../agents/culture-score/culture-score.agent.js";
import { HireScoreAgent } from "../../agents/hire-score/hire-score.agent.js";
import { ScoreSummaryAgent } from "../../agents/score-summary/score-summary.agent.js";
import { SkillsScoreAgent } from "../../agents/skills-score/skills-score.agent.js";
import { PanelScoreArbiter } from "../../arbiters/panel-score/panel-score.arbiter.js";
import { PanelReviewWorkflowFinish } from "./panel-review.workflow-finish.js";
import { PanelUndecidedWorkflowFinish } from "./panel-undecided.workflow-finish.js";
import { PanelWorkflowStart } from "./panel.workflow-start.js";

/**
 * A quorum (#279): three panelists score a candidate side by side; a score counts when it is in
 * range (code, cheap — first) and its reason meets its panelist's criterion (the arbiter's own model,
 * asked only about a score in range).
 * Two counted scores are enough, the third is waited for until the deadline; the rest is
 * cancelled. No quorum by then: the candidate goes to a person.
 */
@Workflow({
  name: "panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel([toAgent(SkillsScoreAgent), toAgent(CultureScoreAgent), toAgent(HireScoreAgent)])
      .arbitratedBy(PanelScoreArbiter)
      .joinQuorum({ min: 2, max: 3, deadline: seconds(30) })
      .onError(StepError.QuorumNotReached, toFinish(PanelUndecidedWorkflowFinish))
      .toAgent(ScoreSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class PanelWorkflow {}
