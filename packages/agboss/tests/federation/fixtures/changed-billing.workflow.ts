import { hours, minutes } from "../../../src/units/index.js";
import { A2AEndpoint } from "../../../src/a2a/index.js";
import { Application } from "../../../src/application/application.js";
import {
  Agent,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { RenamedBillingAnswerDto, StrictBillingQuestionDto } from "./billing.dto.js";

export { RenamedBillingAnswerDto, StrictBillingQuestionDto } from "./billing.dto.js";

/** A billing desk whose contract changed under the shop (#398 PR 4). */

@WorkflowStart({
  name: "billing-workflow-start",
  description: "A billing question",
  input: StrictBillingQuestionDto,
})
export class ChangedBillingWorkflowStart {}

@Agent({
  name: "billing-desk-agent",
  description: "Answers invoice questions",
  model: "test/billing",
  input: { question: StrictBillingQuestionDto },
  output: RenamedBillingAnswerDto,
})
export class ChangedBillingDeskAgent {}

@WorkflowFinish({
  name: "billing-workflow-finish",
  description: "The answer",
  output: RenamedBillingAnswerDto,
})
export class ChangedBillingWorkflowFinish {}

@Workflow({
  name: "billing-workflow",
  version: "1.0.0",
  flow: [
    onStart(ChangedBillingWorkflowStart)
      .toAgent(ChangedBillingDeskAgent)
      .toFinish(ChangedBillingWorkflowFinish),
  ],
})
export class ChangedBillingWorkflow {}

@A2AEndpoint({
  name: "billing-a2a-expose",
  description: "Served over A2A",
  version: "1.0.0",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [ChangedBillingWorkflowStart],
})
export class ChangedBillingA2AExpose {}

@Application({
  name: "billing-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChangedBillingWorkflow],
  budgets: TEST_BUDGETS,
  endpoints: [ChangedBillingA2AExpose],
})
export class ChangedBillingApplication {}
