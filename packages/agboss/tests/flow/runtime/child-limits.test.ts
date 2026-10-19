import { beforeEach, describe, expect } from "vitest";
import {
  BudgetExceededError,
  BudgetScope,
  ChildExecutionFailedError,
  ChildExecutionStatus,
} from "../../../src/index.js";
import { replyWith, testWith, type ModelRequest } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { TestExecutionBudget } from "../fixtures/budgets.js";
import { ItemResultDto, SummaryDto, type ItemDto } from "./fixtures/fan-out.workflow.js";
import {
  ChildBudgetsApplication,
  ChildrenApplication,
  childLog,
  ItemNoteDto,
  ItemReviewedWorkflowFinish,
  ItemReviewerAgent,
  ItemReviewExecutionBudget,
  ItemReviewWorkflowStart,
  resetChildLog,
  ReviewItemsWorkflowStart,
  ReviewOneWorkflowStart,
  ReviewRescueAgent,
  ReviewsSummaryWorkflowFinish,
  ReviewStoppedWorkflowFinish,
  ReviewsWorkflowFinish,
} from "./fixtures/children.workflow.js";

/** #263 PR 2 — limits and spend across the tree: AC10, S25, #261 S76 h. */

const test = testWith(ChildrenApplication);
const budgeted = testWith(ChildBudgetsApplication);
const who = { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u1" } };
const item = (name: string): ItemDto => ({ name, delay: 0, outcome: "ok" });

/** The item a request is about. */
const nameIn = (request: ModelRequest): string => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  return /"name": "(\w+)"/.exec(input)?.[1] ?? "?";
};

/** "loop…" items go round for ever; the others are reviewed at once. */
const reviewer = (request: ModelRequest) => {
  const name = nameIn(request);
  return name.startsWith("loop")
    ? replyWith(ItemNoteDto, { note: "again" }, { cost: usd(0.001) })
    : replyWith(ItemResultDto, { name }, { cost: usd(0.01) });
};

beforeEach(resetChildLog);

describe("S25: a child's own limit is the child's failure", () => {
  test("child maxSteps → ChildExecutionFailedError with cause; the handler may be an agent", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);
    mockLlm(ReviewRescueAgent).thenReturn(replyWith(SummaryDto, { text: "skip loop" }));

    const result = await execute(app, ReviewItemsWorkflowStart, [item("loop")], who);

    expect(result).toFinishWith(ReviewsWorkflowFinish, { text: "skip loop" });
    expect(result.handledErrors).toMatchObject([
      {
        error: { code: "step.child", cause: { code: "limit.steps" } },
        at: { name: "item-review-workflow" },
        by: { name: "review-rescue-agent" },
      },
    ]);
    expect(result.children).toMatchObject([
      {
        status: ChildExecutionStatus.Failed,
        path: ["item-review-workflow-start", "item-reviewer-agent", "item-reviewer-agent"],
      },
    ]);
  });

  test("a handler naming the limit catches the child's through the cause chain", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);

    const result = await execute(app, ReviewOneWorkflowStart, item("loop"), who);

    expect(result).toFinishWith(ReviewStoppedWorkflowFinish, { text: "stopped on loop" });
  });

  test("the child's steps are its own: the parent's maxSteps counts the parent's only", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(ItemReviewerAgent).thenAnswer(reviewer);
    const names = ["a", "b", "c", "d", "e", "f"];

    // six children, one step each; the parent's maxSteps is 4 and it has no agent step of its own
    const result = await execute(app, ReviewItemsWorkflowStart, names.map(item), who);

    expect(result).toFinishWith(ReviewsSummaryWorkflowFinish, { text: "a, b, c, d, e, f" });
  });
});

describe("AC10: money is the whole pass", () => {
  budgeted(
    "budget passes through: a budget hit inside a child stops the whole execution, unwrapped",
    async ({ app, mockLlm, mockOf }) => {
      mockOf(TestExecutionBudget).maxSpend.mockReturnValue(usd(0.0005));
      mockLlm(ItemReviewerAgent).thenAnswer(reviewer);

      const error: unknown = await execute(app, ReviewOneWorkflowStart, item("loop"), who).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(BudgetExceededError);
      expect(error).not.toBeInstanceOf(ChildExecutionFailedError);
      const [root] = childLog.starts;
      expect(error).toMatchObject({
        budget: { name: "test-execution-budget" },
        scope: BudgetScope.Execution,
        key: root?.executionId,
      });
      // the child's first call (0.001) travels with the error to the ledger
      expect((error as BudgetExceededError).usage.length).toBeGreaterThan(0);
    },
  );

  budgeted(
    "spend per child: the root's spend holds every child's, each child its own",
    async ({ app, mockLlm }) => {
      mockLlm(ItemReviewerAgent).thenAnswer(reviewer);

      const result = await execute(app, ReviewItemsWorkflowStart, [item("a"), item("b")], who);

      expect(result).toFinishWith(ReviewsSummaryWorkflowFinish, { text: "a, b" });
      expect(result.spend.totalUsd).toBeCloseTo(0.02, 6);
      expect(result.children.map((child) => child.spend.totalUsd)).toEqual([0.01, 0.01]);
      expect(result.spend.byCaller).toMatchObject({ "item-reviewer-agent": 0.02 });
    },
  );

  budgeted(
    "a child's own execution budget applies only when it is the root",
    async ({ app, mockLlm, mockOf }) => {
      mockOf(ItemReviewExecutionBudget).maxSpend.mockReturnValue(usd(0));
      mockLlm(ItemReviewerAgent).thenAnswer(reviewer);

      const asChild = await execute(app, ReviewOneWorkflowStart, item("a"), who);
      const alone = execute(app, ItemReviewWorkflowStart, item("a"), who);

      expect(asChild).toFinishWith(ItemReviewedWorkflowFinish, { name: "a" });
      await expect(alone).rejects.toMatchObject({
        budget: { name: "item-review-execution-budget" },
      });
    },
  );
});
