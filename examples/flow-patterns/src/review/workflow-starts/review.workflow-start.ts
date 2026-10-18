import { WorkflowStart } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";

/** Where a review starts: the manuscript. */
@WorkflowStart({
  name: "review-workflow-start",
  description: "A manuscript to review",
  input: WorkflowStartTextDto,
})
export class ReviewWorkflowStart {}
