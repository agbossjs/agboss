/**
 * #659 AC4: a free-text reply to a question is read by its role's interpreter into the role's
 * `answer` DTO — by code or by a chat model; a reply it does not understand keeps the pause pending.
 * #659 AC2: a channel whose `send` throws fails the step as `QuestionFailedError`, which `.onError`
 * takes.
 */
import { describe, expect } from "vitest";
import { UninterpretableReplyError } from "../../src/index.js";
import { ReplyInterpreterNotUnderstoodDto } from "../../src/dto/index.js";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import { PauseStatus, PausedExecutionRepository } from "../../src/index.js";
import { override, replyWith, testWith } from "../../src/testing/index.js";
import {
  BudgetOwnerReplyInterpreter,
  OwnerPurchaseWorkflowFinish,
  OwnerPurchaseWorkflowStart,
  PurchaseUnaskedWorkflowFinish,
  PurchaseWorkflowFinish,
  PurchaseWorkflowStart,
  QuestionInbox,
  QuestionsApplication,
  SpendingLimitAnswerDto,
  SpendingLimitQuestion,
} from "../flow/fixtures/questions.fixture.js";
import { execute } from "../helpers/flow.js";

const test = testWith(QuestionsApplication);

const owner = { ownerId: "alice" };
const asking = { threadId: "purchase-1", ownerId: "alice" };
const by = { answeredBy: "budget-owner-7" };

describe("#659 AC4: a code interpreter reads the reply into the answer", () => {
  test("AC4: 'up to 1200' is understood: the answer goes on the path", async ({ app }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    const done = await app.resume({ pauseId, reply: "sure, up to 1200" }, owner);

    expect(done).toFinishWith(PurchaseWorkflowFinish, {
      status: "placed laptop at 900 within 1200",
    });
    expect(app.resolve(QuestionInbox).placed).toEqual([{ approved: true, limitUsd: 1200 }]);
  });

  test("AC4: a reply it does not understand keeps the pause pending; a clearer one resumes", async ({
    app,
  }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);
    const pauseId = paused.pending[0]?.pauseId ?? "";

    const unread = await app
      .resume({ pauseId, reply: "🤷" }, owner)
      .catch((error: unknown) => error);

    expect(unread).toBeInstanceOf(UninterpretableReplyError);
    expect(unread).toMatchObject({ reason: '"🤷" names no limit' });
    const pauses = app.resolve(PausedExecutionRepository);
    expect((await pauses.findByTenantIdAndPauseId("default", pauseId))?.status).toBe(
      PauseStatus.Pending,
    );
    const done = await app.resume({ pauseId, reply: "no" }, owner);
    expect(done).toFinishWith(PurchaseWorkflowFinish, { status: "declined laptop" });
  });
});

describe("#659 AC4: a chat-model interpreter answers with the answer DTO's tool", () => {
  test("AC4: the model reads the question and the reply; its answer resumes", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(BudgetOwnerReplyInterpreter)
      .when({ reply: "fine, up to eight hundred" })
      .thenReturn(replyWith(SpendingLimitAnswerDto, { approved: true, limitUsd: 800 }));
    await execute(app, OwnerPurchaseWorkflowStart, { text: "desk for 700" });
    const pauseId = app.resolve(QuestionInbox).ownerAsked[0]?.pauseId ?? "";

    const done = await app.resume({ pauseId, reply: "fine, up to eight hundred" }, by);

    expect(done).toFinishWith(OwnerPurchaseWorkflowFinish, { status: "placed within 800" });
    const interpreter = mockLlm(BudgetOwnerReplyInterpreter);
    expect(interpreter.inputs).toEqual([
      {
        ask: expect.objectContaining({ item: "desk", priceUsd: 700 }),
        reply: "fine, up to eight hundred",
      },
    ]);
    expect(interpreter.onlyRequest).toMatchObject({
      kind: "chat",
      input: expect.stringMatching(/"priceUsd": 700[\s\S]*### reply\n"fine, up to eight hundred"/),
      system: expect.stringContaining("the answer tool with the fields the reply gives"),
    });
    expect(interpreter.onlyRequest).not.toMatchObject({
      system: expect.stringContaining("overrideArguments"),
    });
    // the question's sensitive field is masked for the model too
    expect(JSON.stringify(interpreter.onlyRequest)).not.toContain("alice");
  });

  test("AC4: the model's not-understood tool keeps the pause pending", async ({ app, mockLlm }) => {
    mockLlm(BudgetOwnerReplyInterpreter).thenReturn(
      replyWith(ReplyInterpreterNotUnderstoodDto, { reason: "a shrug" }),
    );
    await execute(app, OwnerPurchaseWorkflowStart, { text: "desk for 700" });
    const pauseId = app.resolve(QuestionInbox).ownerAsked[0]?.pauseId ?? "";

    await expect(app.resume({ pauseId, reply: "🤷" }, by)).rejects.toMatchObject({
      reason: expect.stringContaining("a shrug"),
    });
    const pause = await app
      .resolve(PausedExecutionRepository)
      .findByTenantIdAndPauseId("default", pauseId);
    expect(pause?.status).toBe(PauseStatus.Pending);
  });
});

/** A channel whose transport is down. */
class DownChannel extends ChannelOf<SpendingLimitQuestion> {
  send(): never {
    throw new Error("inbox unreachable");
  }
}

const down = testWith(QuestionsApplication, {
  overrides: [override(SpendingLimitQuestion, DownChannel)],
});

describe("#659 AC2: a send that throws is the step's failure", () => {
  down("AC2: QuestionFailedError, taken by .onError right after the step", async ({ app }) => {
    const done = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

    expect(done).toFinishWith(PurchaseUnaskedWorkflowFinish, {
      item: "laptop",
      priceUsd: 900,
      requester: "alice",
    });
    expect(done.handledErrors).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          code: "step.question",
          message: expect.stringContaining("inbox unreachable"),
        }),
      }),
    ]);
  });
});
