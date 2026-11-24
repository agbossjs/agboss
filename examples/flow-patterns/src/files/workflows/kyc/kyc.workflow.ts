import { Workflow, onStart } from "@agboss/core";
import { KycAgent } from "../../agents/kyc/kyc.agent.js";
import { IdCheckRequestDto } from "../../dto/id-check-request.dto.js";
import { KycResultWorkflowFinish } from "./kyc-result.workflow-finish.js";
import { KycWorkflowStart } from "./kyc.workflow-start.js";

/** The files of a kyc request, read by one agent. */
@Workflow({
  name: "kyc-workflow",
  version: "1.0.0",
  flow: [
    onStart(KycWorkflowStart)
      .returns(IdCheckRequestDto)
      .toAgent(KycAgent)
      .toFinish(KycResultWorkflowFinish),
  ],
})
export class KycWorkflow {}
