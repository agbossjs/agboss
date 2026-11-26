import { hours, minutes, Ttl } from "../../../src/units/index.js";
import { A2AEndpoint } from "../../../src/a2a/index.js";
import { Application } from "../../../src/application/application.js";
import {
  Agent,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { BillingAnswerDto, BillingQuestionDto } from "./billing.dto.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

export { BillingAnswerDto, BillingQuestionDto } from "./billing.dto.js";

/** A billing desk that accepts what the shop sends and gives what it reads (#398 PR 4). */

@WorkflowStart({
  name: "billing-workflow-start",
  description: "A billing question",
  input: BillingQuestionDto,
})
export class CompatibleBillingWorkflowStart {}

@Agent({
  name: "billing-desk-agent",
  description: "Answers invoice questions",
  model: "test/billing",
  input: { question: BillingQuestionDto },
  output: BillingAnswerDto,
})
export class CompatibleBillingDeskAgent {}

@WorkflowFinish({
  name: "billing-workflow-finish",
  description: "The answer",
  output: BillingAnswerDto,
})
export class CompatibleBillingWorkflowFinish {}

@Workflow({
  name: "billing-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(CompatibleBillingWorkflowStart)
      .toAgent(CompatibleBillingDeskAgent)
      .toFinish(CompatibleBillingWorkflowFinish),
  ],
})
export class CompatibleBillingWorkflow {}

@A2AEndpoint({
  name: "billing-a2a-expose",
  description: "Served over A2A",
  version: "1.0.0",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [CompatibleBillingWorkflowStart],
})
export class CompatibleBillingA2AExpose {}

@Application({
  name: "billing-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [CompatibleBillingWorkflow],
  budgets: TEST_BUDGETS,
  endpoints: [CompatibleBillingA2AExpose],
})
export class CompatibleBillingApplication {}
