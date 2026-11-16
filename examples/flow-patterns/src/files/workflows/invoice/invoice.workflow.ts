import { Workflow, start } from "@agboss/core";
import { InvoiceReaderAgent } from "../../agents/invoice-reader/invoice-reader.agent.js";
import { InvoiceRequestDto } from "../../dto/invoice-request.dto.js";
import { InvoiceResultWorkflowFinish } from "./invoice-result.workflow-finish.js";
import { InvoiceWorkflowStart } from "./invoice.workflow-start.js";

/** The files of a invoice request, read by one agent. */
@Workflow({
  name: "invoice-workflow",
  version: "1.0.0",
  flow: [
    start(InvoiceWorkflowStart)
      .returns(InvoiceRequestDto)
      .toAgent(InvoiceReaderAgent)
      .toFinish(InvoiceResultWorkflowFinish),
  ],
})
export class InvoiceWorkflow {}
