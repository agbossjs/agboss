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
    start(ChangedBillingWorkflowStart)
      .returns(StrictBillingQuestionDto)
      .toAgent(ChangedBillingDeskAgent)
      .returns(RenamedBillingAnswerDto)
      .toFinish(ChangedBillingWorkflowFinish),
  ],
})
export class ChangedBillingWorkflow {}

@A2AExpose({ name: "billing-a2a-expose", version: "1.0.0", exports: [ChangedBillingWorkflowStart] })
export class ChangedBillingA2AExpose {}

@Application({
  name: "billing-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChangedBillingWorkflow],
  budgets: TEST_BUDGETS,
  exposes: [ChangedBillingA2AExpose],
})
export class ChangedBillingApplication {}
