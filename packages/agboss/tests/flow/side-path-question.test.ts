/**
 * #933 AC1: `.onError(E, toQuestion(Q)…)` — a question role's step starts a side path: the failure
 * is handled by asking, and the answer goes on the path. A question after a limit stays refused.
 */
import { describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { BudgetExceededError } from "../../src/graph/limits.js";
import { StepFailedError } from "../../src/graph/errors.js";
import { PauseKind } from "../../src/pause/index.js";
import { testWith } from "../../src/testing/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import { WorkflowStartTextDto } from "./fixtures/dtos.js";
import { toQuestion as publicToQuestion } from "../../src/flow/builder.js";
import { VisitsLimitExceededError } from "../../src/flow/runtime/errors.js";
import { side, start, toQuestion } from "./fixtures/paths.js";
import {
  DraftQuestionAction,
  PlacePurchaseAction,
  PurchasePlacedDto,
  PurchaseQuestionDto,
  PurchaseWorkflowFinish,
  InboxSpendingLimitChannel,
  QuestionInbox,
  SpendingLimitAnswerDto,
  SpendingLimitQuestion,
} from "./fixtures/questions.fixture.js";
import {
  EdgeCalls,
  EdgeOnceQuestion,
  EdgeOnceStart,
  EdgeTwiceStart,
  PublicStarterWorkflowStart,
  SideQuestionEdgeApplication,
  inlineTwiceEdgeFlow,
  sharedEdgeFlow,
} from "./fixtures/side-question-edge.fixture.js";
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

describe("#933: the shipped toQuestion starter", () => {
  it("toQuestion(Q) builds the same path as side().toQuestion(Q)", () => {
    // a starter that records another node kind (toAgent) builds a different path
    expect(publicToQuestion(SpendingLimitQuestion)).toEqual(
      side().toQuestion(SpendingLimitQuestion),
    );
  });

  const edgeTest = testWith(SideQuestionEdgeApplication);

  edgeTest(
    "a workflow written with the public starter pauses on the side-path question",
    async ({ app }) => {
      const paused = await execute(
        app,
        PublicStarterWorkflowStart,
        { text: "laptop for 900" },
        asking,
      );

      expect(paused.pending).toEqual([
        expect.objectContaining({ kind: PauseKind.Question, step: "spending-limit-question" }),
      ]);
      const done = await app.resume(answerOf(paused, { approved: true, limitUsd: 1000 }), {
        ownerId: "alice",
      });
      expect(done).toFinishWith(PurchaseWorkflowFinish, {
        status: "placed laptop at 900 within 1000",
      });
    },
  );
});

describe("#933 edge: the same role on the main path and on the side path", () => {
  const edgeTest = testWith(SideQuestionEdgeApplication);

  edgeTest(
    "written once with question(R) it is one node; maxVisits 2 pauses twice, then finishes",
    async ({ app }) => {
      const first = await execute(app, EdgeTwiceStart, { text: "laptop for 900" }, asking);
      expect(first.pending.map(({ step }) => step)).toEqual(["edge-twice-question"]);

      // the answer goes to the failing action; the side path asks the same node again
      const second = await app.resume(answerOf(first, { approved: true, limitUsd: 1000 }), {
        ownerId: "alice",
      });
      expect(second.status).toBe(ExecutionStatus.Paused);
      expect(second.pending.map(({ step }) => step)).toEqual(["edge-twice-question"]);

      const done = await app.resume(answerOf(second, { approved: true, limitUsd: 2000 }), {
        ownerId: "alice",
      });
      expect(done).toFinishWith(PurchaseWorkflowFinish, { status: "placed laptop within 2000" });
      expect(done.path).toEqual([
        "edge-twice-workflow-start",
        "draft-question-action",
        "edge-twice-question",
        "fail-first-place-action",
        "edge-twice-question",
        "fail-first-place-action",
        "purchase-workflow-finish",
      ]);
      expect(app.resolve(EdgeCalls).calls).toBe(2);
    },
  );

  edgeTest(
    "maxVisits 1: the side-path visit is the second one → VisitsLimitExceededError",
    async ({ app }) => {
      const first = await execute(app, EdgeOnceStart, { text: "laptop for 900" }, asking);

      await expect(
        app.resume(answerOf(first, { approved: true, limitUsd: 1000 }), { ownerId: "alice" }),
      ).rejects.toBeInstanceOf(VisitsLimitExceededError);
    },
  );

  let count = 0;
  const codesOf = (flow: ReturnType<typeof sharedEdgeFlow>) => {
    count += 1;
    @Workflow({ name: `edge-case-${String(count)}-workflow`, version: "1.0.0", flow })
    class EdgeWorkflow {}
    return checkWorkflow(EdgeWorkflow).errors.map(({ code, message }) => `[${code}] ${message}`);
  };

  it("written once with question(R) it passes assembly", () => {
    expect(codesOf(sharedEdgeFlow(EdgeOnceStart, EdgeOnceQuestion))).toEqual([]);
  });

  it("written inline twice → [flow.continuation-twice]", () => {
    expect(codesOf(inlineTwiceEdgeFlow(EdgeOnceStart, EdgeOnceQuestion))).toEqual([
      expect.stringContaining("[flow.continuation-twice]"),
    ]);
  });
});

describe("#933: a concrete channel class as the question", () => {
  it("[graph.not-a-node] names the question role", () => {
    @Workflow({
      name: "channel-class-question-workflow",
      version: "1.0.0",
      flow: [
        start(SideQuestionWorkflowStart)
          .returns(WorkflowStartTextDto)
          .toAction(DraftQuestionAction)
          .returns(PurchaseQuestionDto)
          .toAction(FlakyCheckAction)
          .onError(
            StepFailedError,
            toQuestion(InboxSpendingLimitChannel)
              .returns(SpendingLimitAnswerDto)
              .toFinish(PurchaseWorkflowFinish),
          )
          .returns(PurchasePlacedDto)
          .toFinish(PurchaseWorkflowFinish),
      ],
    })
    class ChannelClassWorkflow {}

    expect(checkWorkflow(ChannelClassWorkflow).errors.map(({ message }) => message)).toEqual([
      expect.stringContaining("a question is a @ChannelRole class"),
    ]);
  });
});
