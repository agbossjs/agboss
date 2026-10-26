import { WorkflowStart } from "@agboss/core";
import { CandidateDto } from "../dtos/candidate.dto.js";

/** Where a panel starts: the candidate. */
@WorkflowStart({
  name: "panel-workflow-start",
  description: "A candidate to score",
  input: CandidateDto,
})
export class PanelWorkflowStart {}
