/**
 * #712 AC4: #659's guarantees hold for a question an agent asks through its tool loop — one answer
 * wins (one after the other, at once on two instances), another instance resumes it without asking
 * again, a cancel withdraws it, another tenant or owner cannot answer it, the role's `maxVisits`
 * bounds the calls of one visit, and a channel that fails fails the agent's step.
 */
import { describe, expect } from "vitest";
import { UnknownPauseError } from "../../src/app/resume.js";
import { AgentFailedError } from "../../src/graph/errors.js";
import { DtoValidationError } from "../../src/dto/errors.js";
import { NotPausedError, PauseStatus, PausedExecutionRepository } from "../../src/index.js";
import { ThreadOwnerError } from "../../src/run/thread.js";
import { VisitsLimitExceededError } from "../../src/flow/runtime/errors.js";
import { callTool, callTools, replyWith, testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import {
  ApproverQuestion,
  BuyerAgent,
  BuyerDesk,
  BuyerWorkflowFinish,
  BuyerWorkflowStart,
  DownQuestionToolsApplication,
  WrongQuestionToolsApplication,
  OwnerBuyerAgent,
  OwnerBuyerWorkflowStart,
  QuestionToolsApplication,
} from "../flow/fixtures/question-tools.fixture.js";
import { answerOf, execute } from "../helpers/flow.js";
import { TestTenantDailyBudget } from "../flow/fixtures/budgets.js";
import { BudgetExceededError } from "../../src/index.js";
import { usd } from "../../src/units/index.js";

const test = testWith(QuestionToolsApplication, { instances: 2 });
const down = testWith(DownQuestionToolsApplication);
const wrong = testWith(WrongQuestionToolsApplication);

const owner = { ownerId: "alice" };
const asking = { threadId: "buy-1", ownerId: "alice" };
const laptop = { item: "laptop", priceUsd: 900 };
const yes = { approved: true, limitUsd: 1000 };
const no = { approved: false, limitUsd: 0 };

const second = (apps: readonly TestApp[]): TestApp => {
  const [, other] = apps;
  if (other === undefined) throw new Error("the test runs two instances");
  return other;
};

const statusOf = async (app: TestApp, pauseId: string): Promise<PauseStatus | undefined> =>
  (await app.resolve(PausedExecutionRepository).findByTenantIdAndPauseId("default", pauseId))
    ?.status;

describe("#712 AC4: exactly one answer wins", () => {
  test("AC4: a second answer after the first is NotPausedError", async ({ app, mockLlm }) => {
    mockLlm(BuyerAgent).thenReturn(callTool(ApproverQuestion, laptop), replyWith("done"));
    const paused = await execute(app, BuyerWorkflowStart, { text: "buy" }, asking);
    const done = await app.resume(answerOf(paused, yes), owner);

    await expect(app.resume(answerOf(paused, no), owner)).rejects.toBeInstanceOf(NotPausedError);
    expect(done).toFinishWith(BuyerWorkflowFinish, { text: "done" });
    expect(mockLlm(BuyerAgent).requests).toHaveLength(2);
  });

  test("AC4: two answers at once on two instances: one moves the tree, the other is refused", async ({
    app,
    apps,
    mockLlm,
  }) => {
    mockLlm(BuyerAgent).thenReturn(callTool(ApproverQuestion, laptop), replyWith("done"));
    const paused = await execute(app, BuyerWorkflowStart, { text: "buy" }, asking);

    const settled = await Promise.allSettled([
      app.resume(answerOf(paused, yes), owner),
      second(apps).resume(answerOf(paused, no), owner),
    ]);

    expect(settled.filter((each) => each.status === "fulfilled")).toHaveLength(1);
    const lost = settled.flatMap((each): unknown[] =>
      each.status === "rejected" ? [each.reason] : [],
    );
    expect(lost).toEqual([expect.any(NotPausedError)]);
    // the model read the answer once: its second turn, after exactly one answer
    expect(mockLlm(BuyerAgent).requests).toHaveLength(2);
  });

  test("AC4: asked on one instance, answered on the other: the channel is never asked again", async ({
    app,
    apps,
    mockLlm,
  }) => {
    mockLlm(BuyerAgent).thenReturn(callTool(ApproverQuestion, laptop), replyWith("done"));
    const paused = await execute(app, BuyerWorkflowStart, { text: "buy" }, asking);

    const done = await second(apps).resume(answerOf(paused, yes), owner);

    expect(done).toFinishWith(BuyerWorkflowFinish, { text: "done" });
    expect(app.resolve(BuyerDesk).asked).toHaveLength(1);
    expect(second(apps).resolve(BuyerDesk).asked).toEqual([]);
  });
});

describe("#712 AC4: cancel, tenants and owners", () => {
  test("AC4: app.cancel while paused withdraws the question; a late answer is refused", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BuyerAgent).thenReturn(callTool(ApproverQuestion, laptop));
    const paused = await execute(app, BuyerWorkflowStart, { text: "buy" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    await app.cancel("buy-1", owner);

    expect(await statusOf(app, pauseId)).toBe(PauseStatus.Cancelled);
    await expect(app.resume(answerOf(paused, yes), owner)).rejects.toBeInstanceOf(NotPausedError);
  });

  test("AC4: another tenant's id is unknown; another owner is refused; it stays pending", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BuyerAgent).thenReturn(callTool(ApproverQuestion, laptop));
    const paused = await execute(app, BuyerWorkflowStart, { text: "buy" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    await expect(
      app.resume(answerOf(paused, yes), { tenantId: "acme", ownerId: "alice" }),
    ).rejects.toBeInstanceOf(UnknownPauseError);
    await expect(app.resume(answerOf(paused, yes), { ownerId: "mallory" })).rejects.toBeInstanceOf(
      ThreadOwnerError,
    );
    expect(await statusOf(app, pauseId)).toBe(PauseStatus.Pending);
  });
});

describe("#712 AC4: maxVisits, several calls of one move, a failing channel", () => {
  test("AC4: two calls of one move are asked one after the other", async ({ app, mockLlm }) => {
    // by the request: the first turn asks both at once, the one after both answers replies
    mockLlm(BuyerAgent).thenAnswer((request) =>
      request.kind === "chat" && request.messages.some((line) => line.role === "tool")
        ? replyWith("both answered")
        : callTools(
            callTool(ApproverQuestion, laptop),
            callTool(ApproverQuestion, { item: "dock", priceUsd: 200 }),
          ),
    );
    const first = await execute(app, BuyerWorkflowStart, { text: "buy" }, asking);
    expect(first.pending.map((pause) => pause.ask)).toEqual([laptop]);

    const next = await app.resume(answerOf(first, yes), owner);
    expect(next.pending.map((pause) => pause.ask)).toEqual([{ item: "dock", priceUsd: 200 }]);

    const done = await app.resume(answerOf(next, no), owner);
    expect(done).toFinishWith(BuyerWorkflowFinish, { text: "both answered" });
    expect(app.resolve(BuyerDesk).asked).toHaveLength(2);
  });

  test("AC4: the call past the role's maxVisits fails the step before it is asked", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BuyerAgent).thenReturn(
      callTool(ApproverQuestion, laptop),
      callTool(ApproverQuestion, laptop),
      callTool(ApproverQuestion, laptop),
    );
    const first = await execute(app, BuyerWorkflowStart, { text: "buy" }, asking);
    const again = await app.resume(answerOf(first, { approved: true, limitUsd: 500 }), owner);

    await expect(
      app.resume(answerOf(again, { approved: true, limitUsd: 600 }), owner),
    ).rejects.toBeInstanceOf(VisitsLimitExceededError);
    expect(app.resolve(BuyerDesk).asked).toHaveLength(2);
  });
});

describe("#712 AC4: a budget exhausted meanwhile asks nobody", () => {
  test("AC4: the move's second question is not asked once another execution spent the tenant's budget", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(TestTenantDailyBudget).maxSpend.mockReturnValue(usd(0.01));
    mockLlm(BuyerAgent).thenAnswer(() =>
      callTools(
        callTool(ApproverQuestion, laptop),
        callTool(ApproverQuestion, { item: "dock", priceUsd: 200 }),
      ),
    );
    mockLlm(OwnerBuyerAgent).thenReturn(replyWith("spent", { cost: usd(0.02) }));
    const first = await execute(app, BuyerWorkflowStart, { text: "buy" }, asking);
    // another execution of the tenant spends past its budget while the first one waits
    const spender = await execute(
      app,
      OwnerBuyerWorkflowStart,
      { text: "spend" },
      { threadId: "spend-1" },
    );
    expect(spender.spend.totalUsd).toBeGreaterThan(0.01);

    await expect(app.resume(answerOf(first, yes), owner)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(app.resolve(BuyerDesk).asked).toHaveLength(1);
  });
});

describe("#712 AC4: a channel that fails", () => {
  down(
    "AC4: a send that throws fails the agent's step, the channel's error its cause",
    async ({ app, mockLlm }) => {
      mockLlm(BuyerAgent).thenReturn(callTool(ApproverQuestion, laptop));

      await expect(execute(app, BuyerWorkflowStart, { text: "buy" }, asking)).rejects.toFailWith(
        AgentFailedError,
        { cause: expect.objectContaining({ message: "the approvals service is down" }) },
      );
    },
  );

  wrong(
    "AC4: a channel's decided(…) that is no valid answer fails the step, the validation its cause",
    async ({ app, mockLlm }) => {
      mockLlm(BuyerAgent).thenReturn(callTool(ApproverQuestion, laptop));

      await expect(execute(app, BuyerWorkflowStart, { text: "buy" }, asking)).rejects.toFailWith(
        AgentFailedError,
        { cause: expect.any(DtoValidationError) },
      );
    },
  );
});
