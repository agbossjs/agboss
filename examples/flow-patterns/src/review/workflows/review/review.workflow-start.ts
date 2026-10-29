import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

/** Where a review starts: the manuscript. */
@WorkflowStart({
  name: "review-workflow-start",
  description: "A manuscript to review",
  input: WorkflowStartTextDto,
})
export class ReviewWorkflowStart {}
