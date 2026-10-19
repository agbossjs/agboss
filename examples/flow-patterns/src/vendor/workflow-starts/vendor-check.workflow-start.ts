import { WorkflowStart } from "agboss";
import { VendorDto } from "../dtos/vendor.dto.js";

/** Where one vendor's check starts: run alone, or by a parent per item of its list. */
@WorkflowStart({
  name: "vendor-check-workflow-start",
  description: "One vendor to check",
  input: VendorDto,
})
export class VendorCheckWorkflowStart {}
