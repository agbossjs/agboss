import { WorkflowFinish } from "@agboss/core";
import { VendorRejectedDto } from "../dtos/vendor-rejected.dto.js";

/** The vendor is not a fit. */
@WorkflowFinish({
  name: "vendor-rejected-workflow-finish",
  description: "The vendor is not a fit",
  output: VendorRejectedDto,
})
export class VendorRejectedWorkflowFinish {}
