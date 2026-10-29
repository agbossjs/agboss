import { WorkflowStart } from "@agboss/core";
import { CandidateDto } from "../../../panel/dto/candidate.dto.js";

/** A candidate to take in. */
@WorkflowStart({
  name: "intake-workflow-start",
  description: "A candidate to take in",
  input: CandidateDto,
})
export class IntakeWorkflowStart {}
