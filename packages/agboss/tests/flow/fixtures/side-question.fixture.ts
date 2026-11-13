import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import {
  DraftQuestionAction,
  InboxSpendingLimitChannel,
  PlacePurchaseAction,
  PurchasePlacedDto,
  PurchaseQuestionDto,
  PurchaseWorkflowFinish,
  QuestionInbox,
  SpendingLimitAnswerDto,
  SpendingLimitQuestion,
} from "./questions.fixture.js";
import { start, toQuestion } from "./paths.js";

/**
 * #933 — `.onError(E, toQuestion(Q)…)`: a purchase whose placing check fails asks the thread's owner
 * for a spending limit on the side path (the question of `questions.fixture.ts`), then places the
 * purchase within the answered limit.
 */

/** Always fails: the failure the side path takes. */
@Action({
  name: "flaky-check-action",
  description: "Fails the check",
  input: { question: PurchaseQuestionDto },
  output: PurchasePlacedDto,
})
export class FlakyCheckAction implements ActionHandler<FlakyCheckAction> {
  execute(_input: InputOf<FlakyCheckAction>): Promise<OutputOf<FlakyCheckAction>> {
    return Promise.reject(new Error("the check is down"));
  }
}

@WorkflowStart({
  name: "side-question-workflow-start",
  description: "d",
  input: WorkflowStartTextDto,
})
export class SideQuestionWorkflowStart {}

@Workflow({
  name: "side-question-workflow",
  version: "1.0.0",
  flow: [
    start(SideQuestionWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(DraftQuestionAction)
      .returns(PurchaseQuestionDto)
      .toAction(FlakyCheckAction)
      .onError(
        StepFailedError,
        toQuestion(SpendingLimitQuestion)
          .returns(SpendingLimitAnswerDto)
          .toAction(PlacePurchaseAction)
          .returns(PurchasePlacedDto)
          .toFinish(PurchaseWorkflowFinish),
      )
      .returns(PurchasePlacedDto)
      .toFinish(PurchaseWorkflowFinish),
  ],
  providers: [QuestionInbox],
})
export class SideQuestionWorkflow {}

@Application({
  name: "side-question-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SideQuestionWorkflow],
  budgets: TEST_BUDGETS,
  providers: [InboxSpendingLimitChannel],
})
export class SideQuestionApplication {}
