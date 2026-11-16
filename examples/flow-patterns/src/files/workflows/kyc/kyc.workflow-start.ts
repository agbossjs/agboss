import { WorkflowStart } from "@agboss/core";
import { IdCheckRequestDto } from "../../dto/id-check-request.dto.js";

/** The files of one kyc request. */
@WorkflowStart({
  name: "kyc-workflow-start",
  description: "The files of one kyc request",
  input: IdCheckRequestDto,
})
export class KycWorkflowStart {}
