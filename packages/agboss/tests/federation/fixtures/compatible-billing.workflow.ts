import { A2AExpose } from "../../../src/a2a/index.js";
import { Application } from "../../../src/application/application.js";
import {
  Agent,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { BillingAnswerDto, BillingQuestionDto } from "./billing.dto.js";

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
  flow: [
    start(CompatibleBillingWorkflowStart)
      .returns(BillingQuestionDto)
      .toAgent(CompatibleBillingDeskAgent)
      .returns(BillingAnswerDto)
      .toFinish(CompatibleBillingWorkflowFinish),
  ],
})
export class CompatibleBillingWorkflow {}

@A2AExpose({
  name: "billing-a2a-expose",
  version: "1.0.0",
  exports: [CompatibleBillingWorkflowStart],
})
export class CompatibleBillingA2AExpose {}

@Application({
  name: "billing-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CompatibleBillingWorkflow],
  budgets: TEST_BUDGETS,
  exposes: [CompatibleBillingA2AExpose],
})
export class CompatibleBillingApplication {}
