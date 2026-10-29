import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

/** Where a screening starts: what the buyer is looking for. */
@WorkflowStart({
  name: "vendor-screening-workflow-start",
  description: "What to buy",
  input: WorkflowStartTextDto,
})
export class VendorScreeningWorkflowStart {}
