import { Workflow, start } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { DeskA2AAgent } from "./a2a/desk.a2a-agent.js";
import { HelplineAgent } from "./agents/helpline.agent.js";
import { HelplineAnswerWorkflowFinish } from "./workflow-finishes/helpline-answer.workflow-finish.js";
import { HelplineWorkflowStart } from "./workflow-starts/helpline.workflow-start.js";

/**
 * The helpline (#398): a consumer of `desk-application` over A2A — its agent's tool calls the
 * desk through the declared contract `DeskA2AAgent`, a provider like any service.
 */
@Workflow({
  name: "helpline-workflow",
  version: "1.0.0",
  flow: [
    start(HelplineWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(HelplineAgent)
      .toFinish(HelplineAnswerWorkflowFinish),
  ],
  providers: [DeskA2AAgent],
})
export class HelplineWorkflow {}
