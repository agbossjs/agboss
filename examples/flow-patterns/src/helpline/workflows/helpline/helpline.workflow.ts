import { Workflow, onStart } from "@agboss/core";
import { DeskA2AAgent } from "../../a2a/desk.a2a-agent.js";
import { HelplineAgent } from "../../agents/helpline/helpline.agent.js";
import { HelplineAnswerWorkflowFinish } from "./helpline-answer.workflow-finish.js";
import { HelplineWorkflowStart } from "./helpline.workflow-start.js";

/**
 * The helpline (#398): a consumer of `desk-application` over A2A — its agent's tool calls the
 * desk through the declared contract `DeskA2AAgent`, a provider like any service.
 */
@Workflow({
  name: "helpline-workflow",
  version: "1.0.0",
  flow: [
    onStart(HelplineWorkflowStart)
      .toAgent(HelplineAgent)
      .toFinish(HelplineAnswerWorkflowFinish),
  ],
  providers: [DeskA2AAgent],
})
export class HelplineWorkflow {}
