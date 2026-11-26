import { StepError } from "../../../src/core/error-families/step-errors.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import { Application } from "../../../src/application/application.js";
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
  SpendingLimitQuestionExternalTask,
} from "./questions.fixture.js";
import { onStart, toExternalTask } from "./paths.js";
import { Ttl } from "../../../src/index.js";

/**
 * #933 — `.onError(E, toExternalTask(Q)…)`: a purchase whose placing check fails asks the thread's owner
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(SideQuestionWorkflowStart)
      .toAction(DraftQuestionAction)
      .toAction(FlakyCheckAction)
      .onError(
        StepError,
        toExternalTask(SpendingLimitQuestionExternalTask)
          .toAction(PlacePurchaseAction)
          .toFinish(PurchaseWorkflowFinish),
      )
      .toFinish(PurchaseWorkflowFinish),
  ],
  providers: [QuestionInbox],
})
export class SideQuestionWorkflow {}

@Application({
  name: "side-question-application",
  version: "1.0.0",
  workflows: [SideQuestionWorkflow],
  budgets: TEST_BUDGETS,
  providers: [InboxSpendingLimitChannel],
})
export class SideQuestionApplication {}
