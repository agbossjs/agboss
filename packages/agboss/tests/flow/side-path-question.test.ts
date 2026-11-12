/**
 * #933 AC1: `.onError(E, toQuestion(Q)…)` — a question role's step starts a side path: the failure
 * is handled by asking, and the answer goes on the path. A question after a limit stays refused.
 */
import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { BudgetExceededError } from "../../src/graph/limits.js";
import { StepFailedError } from "../../src/graph/errors.js";
import { PauseKind } from "../../src/pause/index.js";
import { testWith } from "../../src/testing/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import { WorkflowStartTextDto } from "./fixtures/dtos.js";
import { start, toQuestion } from "./fixtures/paths.js";
import {
  DraftQuestionAction,
  PlacePurchaseAction,
  PurchasePlacedDto,
  PurchaseQuestionDto,
  PurchaseWorkflowFinish,
  QuestionInbox,
  SpendingLimitAnswerDto,
  SpendingLimitQuestion,
} from "./fixtures/questions.fixture.js";
import {
  FlakyCheckAction,
  SideQuestionApplication,
  SideQuestionWorkflowStart,
} from "./fixtures/side-question.fixture.js";

const test = testWith(SideQuestionApplication);
const asking = { threadId: "side-1", ownerId: "alice" };

describe("#933 AC1: a question starts an .onError side path", () => {
  test("AC1: onError(StepFailedError, toQuestion(Q)…) runs the question", async ({ app }) => {
    const paused = await execute(
      app,
      SideQuestionWorkflowStart,
      { text: "laptop for 900" },
      asking,
    );

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.path).toEqual([
      "side-question-workflow-start",
      "draft-question-action",
      "flaky-check-action",
      "spending-limit-question",
    ]);
    // the question reads the ask from the path as the request was drafted
    expect(paused.pending).toEqual([
      expect.objectContaining({
        kind: PauseKind.Question,
        step: "spending-limit-question",
        ask: expect.objectContaining({ item: "laptop", priceUsd: 900 }),
      }),
    ]);
    expect(app.resolve(QuestionInbox).asked).toHaveLength(1);

    const done = await app.resume(answerOf(paused, { approved: true, limitUsd: 1000 }), {
      ownerId: "alice",
    });

    // the answer goes on the path: the action after the question reads it and the ask
    expect(done).toFinishWith(PurchaseWorkflowFinish, {
      status: "placed laptop at 900 within 1000",
    });
    expect(done.path).toEqual([
      "side-question-workflow-start",
      "draft-question-action",
      "flaky-check-action",
      "spending-limit-question",
      "place-purchase-action",
      "purchase-workflow-finish",
    ]);
  });
});

describe("#933 AC1: assembly", () => {
  let count = 0;
  const sidePathCatching = (error: typeof StepFailedError | typeof BudgetExceededError) => {
    count += 1;
    @Workflow({
      name: `side-question-case-${String(count)}-workflow`,
      version: "1.0.0",
      flow: [
        start(SideQuestionWorkflowStart)
          .returns(WorkflowStartTextDto)
          .toAction(DraftQuestionAction)
          .returns(PurchaseQuestionDto)
          .toAction(FlakyCheckAction)
          .onError(
            error,
            toQuestion(SpendingLimitQuestion)
              .returns(SpendingLimitAnswerDto)
              .toAction(PlacePurchaseAction)
              .returns(PurchasePlacedDto)
              .toFinish(PurchaseWorkflowFinish),
          )
          .returns(PurchasePlacedDto)
          .toFinish(PurchaseWorkflowFinish),
      ],
    })
    class CaseWorkflow {}
    return checkWorkflow(CaseWorkflow).errors.map(({ code }) => code);
  };

  test("AC1: a side path catching StepFailedError may start with a question", () => {
    expect(sidePathCatching(StepFailedError)).toEqual([]);
  });

  test("AC1: a side path catching BudgetExceededError reaching toQuestion → [graph.limit-handler-uses-model]", () => {
    expect(sidePathCatching(BudgetExceededError)).toEqual(["graph.limit-handler-uses-model"]);
  });
});
