import { WorkflowFinish } from "@agboss/core";
import { CandidateDto } from "../../dto/candidate.dto.js";

/** Where a panel finishes without a quorum: the candidate, for a person to decide. */
@WorkflowFinish({
  name: "panel-undecided-workflow-finish",
  description: "The candidate, for a person: the panel reached no quorum",
  output: CandidateDto,
})
export class PanelUndecidedWorkflowFinish {}
