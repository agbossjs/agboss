import { WorkflowFinish } from "@agboss/core";
import { VendorCheckFailedDto } from "../dtos/vendor-check-failed.dto.js";

/** The vendor could not be checked: a finish reachable from a side path (no FailFast for the others). */
@WorkflowFinish({
  name: "vendor-check-failed-workflow-finish",
  description: "The vendor could not be checked",
  output: VendorCheckFailedDto,
})
export class VendorCheckFailedWorkflowFinish {}
