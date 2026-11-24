/**
 * #644 (3): `testUnit(Role)` — a role's `@ChannelInterpreter` on its own, as
 * `app.resume({ pauseId, reply })` runs it: the question and the reply in, the role's validated
 * answer or why the reply is not understood out, never a paused execution.
 */
import { describe, expect, it } from "vitest";
import { ReplyInterpreterNotUnderstoodDto } from "../../../src/dto/standard/framework.js";
import { replyWith, testUnit } from "../../../src/testing/index.js";
import { TestSetupError } from "../../../src/testing/errors.js";
import { usd, days } from "../../../src/units/index.js";
import {
  BudgetOwnerQuestionExternalTask,
  PurchaseQuestionDto,
  SpendingLimitAnswerDto,
  SpendingLimitQuestionExternalTask,
} from "../../flow/fixtures/questions.fixture.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";
import { ExternalTask } from "../../../src/channels/pause-targets.js";

const ask = { item: "desk", priceUsd: 700 };

describe("#644: testUnit — a code interpreter", () => {
  it("understood: the role's answer, nothing spent", async () => {
    const read = testUnit(SpendingLimitQuestionExternalTask);

    const { output, spend } = await read({ ask, reply: "sure, up to 500" });

    expect(output).toEqual({ isUnderstood: true, answer: { approved: true, limitUsd: 500 } });
    expect(spend.totalUsd).toBe(0);
  });

  it("not understood: the interpreter's reason — the pause would stay pending", async () => {
    const read = testUnit(SpendingLimitQuestionExternalTask);

    const { output } = await read({ ask, reply: "🤷" });

    expect(output).toEqual({ isUnderstood: false, reason: '"🤷" names no limit' });
  });

  it("a code interpreter calls no model: a model script is a mistake in the test", async () => {
    const read = testUnit(SpendingLimitQuestionExternalTask, {
      model: replyWith(SpendingLimitAnswerDto, { approved: true, limitUsd: 1 }),
    });

    await expect(read({ ask, reply: "up to 5" })).rejects.toBeInstanceOf(TestSetupError);
  });
});

describe("#644: testUnit — a chat-model interpreter", () => {
  it("its answer tool: the answer, validated, its spend under reply-interpreter:<name>", async () => {
    const read = testUnit(BudgetOwnerQuestionExternalTask, {
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
    const shrug = testUnit(BudgetOwnerQuestionExternalTask, {
      model: replyWith(ReplyInterpreterNotUnderstoodDto, { reason: "a shrug" }),
    });
    const invalid = testUnit(BudgetOwnerQuestionExternalTask, {
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
    @ExternalTask({
      name: "typed-only-external-task",
      description: "Answered with a decision only",
      input: PurchaseQuestionDto,
      output: SpendingLimitAnswerDto,
      respondent: PauseRespondent.Owner,
      timeout: days(365),
    })
    class TypedOnlyExternalTask {}
    class NotARole {
      readonly kind = "plain";
    }

    await expect(testUnit(TypedOnlyExternalTask)({ ask, reply: "x" } as never)).rejects.toThrow(
      /names no channelInterpreter/,
    );
    expect(() => testUnit(NotARole)).toThrow(/not a component it runs/);
  });
});
