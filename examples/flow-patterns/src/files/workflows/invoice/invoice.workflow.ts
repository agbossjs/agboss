import { Workflow, onStart } from "@agboss/core";
import { InvoiceReaderAgent } from "../../agents/invoice-reader/invoice-reader.agent.js";
import { InvoiceResultWorkflowFinish } from "./invoice-result.workflow-finish.js";
import { InvoiceFilePolicy } from "../../file-policies/invoice.file-policy.js";
import { InvoiceWorkflowStart } from "./invoice.workflow-start.js";

/** The files of a invoice request, read by one agent. */
@Workflow({
  name: "invoice-workflow",
  version: "1.0.0",
  filePolicy: InvoiceFilePolicy,
  flow: [
    onStart(InvoiceWorkflowStart)
      .toAgent(InvoiceReaderAgent)
      .toFinish(InvoiceResultWorkflowFinish),
  ],
})
export class InvoiceWorkflow {}
