/**
 * #644 (3): `testUnit(Role)` — a role's `@ReplyInterpreter` on its own, as
 * `app.resume({ pauseId, reply })` runs it: the question and the reply in, the role's validated
 * answer or why the reply is not understood out, never a paused execution.
 */
import { describe, expect, it } from "vitest";
import { ChannelOf } from "../../../src/channels/channel-handler.js";
import { ChannelRole, PauseAnswerer } from "../../../src/channels/channel-role.decorator.js";
import { ReplyInterpreterNotUnderstoodDto } from "../../../src/dto/standard/framework.js";
import { replyWith, testUnit } from "../../../src/testing/index.js";
import { TestSetupError } from "../../../src/testing/errors.js";
import { usd } from "../../../src/units/index.js";
import {
  BudgetOwnerQuestion,
  PurchaseQuestionDto,
  SpendingLimitAnswerDto,
  SpendingLimitQuestion,
} from "../../flow/fixtures/questions.fixture.js";

const ask = { item: "desk", priceUsd: 700 };

describe("#644: testUnit — a code interpreter", () => {
  it("understood: the role's answer, nothing spent", async () => {
    const read = testUnit(SpendingLimitQuestion);

    const { output, spend } = await read({ ask, reply: "sure, up to 500" });

    expect(output).toEqual({ isUnderstood: true, answer: { approved: true, limitUsd: 500 } });
    expect(spend.totalUsd).toBe(0);
  });

  it("not understood: the interpreter's reason — the pause would stay pending", async () => {
    const read = testUnit(SpendingLimitQuestion);

    const { output } = await read({ ask, reply: "🤷" });

    expect(output).toEqual({ isUnderstood: false, reason: '"🤷" names no limit' });
  });

  it("a code interpreter calls no model: a model script is a mistake in the test", async () => {
    const read = testUnit(SpendingLimitQuestion, {
      model: replyWith(SpendingLimitAnswerDto, { approved: true, limitUsd: 1 }),
    });

    await expect(read({ ask, reply: "up to 5" })).rejects.toBeInstanceOf(TestSetupError);
  });
});

describe("#644: testUnit — a chat-model interpreter", () => {
  it("its answer tool: the answer, validated, its spend under reply-interpreter:<name>", async () => {
    const read = testUnit(BudgetOwnerQuestion, {
      model: replyWith(
        SpendingLimitAnswerDto,
        { approved: true, limitUsd: 800 },
        { cost: usd(0.001) },
      ),
    });

    const { output, spend } = await read({ ask, reply: "fine, up to eight hundred" });

    expect(output).toEqual({ isUnderstood: true, answer: { approved: true, limitUsd: 800 } });
    expect(spend.byCaller).toEqual({ "reply-interpreter:budget-owner-reply-interpreter": 0.001 });
  });

  it("its not-understood tool, or an answer the role refuses: not understood", async () => {
    const shrug = testUnit(BudgetOwnerQuestion, {
      model: replyWith(ReplyInterpreterNotUnderstoodDto, { reason: "a shrug" }),
    });
    const invalid = testUnit(BudgetOwnerQuestion, {
      model: replyWith(SpendingLimitAnswerDto, { approved: true, limitUsd: -1 }),
    });

    const [first, second] = await Promise.all([
      shrug({ ask, reply: "🤷" }),
      invalid({ ask, reply: "minus one" }),
    ]);

    expect(first.output).toEqual({
      isUnderstood: false,
      reason: expect.stringContaining("a shrug"),
    });
    expect(second.output).toMatchObject({ isUnderstood: false });
  });
});

describe("#644: testUnit — what it refuses", () => {
  it("a role without an interpreter, or a class that is no role", async () => {
    @ChannelRole({
      name: "typed-only-question",
      description: "Answered with a decision only",
      ask: PurchaseQuestionDto,
      answer: SpendingLimitAnswerDto,
      answerer: PauseAnswerer.ThreadOwner,
    })
    abstract class TypedOnlyQuestion extends ChannelOf<TypedOnlyQuestion> {}
    class NotARole {
      readonly kind = "plain";
    }

    await expect(testUnit(TypedOnlyQuestion)({ ask, reply: "x" } as never)).rejects.toThrow(
      /names no replyInterpreter/,
    );
    expect(() => testUnit(NotARole)).toThrow(/not a component it runs/);
  });
});
