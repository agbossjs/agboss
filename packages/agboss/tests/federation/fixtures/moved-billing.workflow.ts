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

/** A billing desk that no longer exports the start the shop names (#398 PR 4). */

@WorkflowStart({
  name: "invoice-workflow-start",
  description: "A billing question",
  input: BillingQuestionDto,
})
export class MovedBillingWorkflowStart {}

@Agent({
  name: "billing-desk-agent",
  description: "Answers invoice questions",
  model: "test/billing",
  input: { question: BillingQuestionDto },
  output: BillingAnswerDto,
})
export class MovedBillingDeskAgent {}

@WorkflowFinish({
  name: "billing-workflow-finish",
  description: "The answer",
  output: BillingAnswerDto,
})
export class MovedBillingWorkflowFinish {}

@Workflow({
  name: "billing-workflow",
  version: "1.0.0",
  flow: [
    start(MovedBillingWorkflowStart)
      .returns(BillingQuestionDto)
      .toAgent(MovedBillingDeskAgent)
      .returns(BillingAnswerDto)
      .toFinish(MovedBillingWorkflowFinish),
  ],
})
export class MovedBillingWorkflow {}

@A2AExpose({ name: "billing-a2a-expose", version: "1.0.0", exports: [MovedBillingWorkflowStart] })
export class MovedBillingA2AExpose {}

@Application({
  name: "billing-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MovedBillingWorkflow],
  budgets: TEST_BUDGETS,
  exposes: [MovedBillingA2AExpose],
})
export class MovedBillingApplication {}
