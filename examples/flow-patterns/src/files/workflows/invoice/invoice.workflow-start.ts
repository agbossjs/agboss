import { WorkflowStart } from "@agboss/core";
import { InvoiceRequestDto } from "../../dto/invoice-request.dto.js";

/** The files of one invoice request. */
@WorkflowStart({
  name: "invoice-workflow-start",
  description: "The files of one invoice request",
  input: InvoiceRequestDto,
})
export class InvoiceWorkflowStart {}
