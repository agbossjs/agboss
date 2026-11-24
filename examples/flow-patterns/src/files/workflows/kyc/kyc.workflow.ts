import { Workflow, onStart } from "@agboss/core";
import { KycAgent } from "../../agents/kyc/kyc.agent.js";
import { KycResultWorkflowFinish } from "./kyc-result.workflow-finish.js";
import { KycFilePolicy } from "./kyc.file-policy.js";
import { KycWorkflowStart } from "./kyc.workflow-start.js";

/** The files of a kyc request, read by one agent. */
@Workflow({
  name: "kyc-workflow",
  version: "1.0.0",
  filePolicy: KycFilePolicy,
  flow: [
    onStart(KycWorkflowStart)
      .toAgent(KycAgent)
      .toFinish(KycResultWorkflowFinish),
  ],
})
export class KycWorkflow {}
