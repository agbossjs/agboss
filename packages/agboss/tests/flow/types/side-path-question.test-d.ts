import { describe, expectTypeOf, it } from "vitest";
import { toExternalTask } from "../../../src/flow/builder.js";
import type { AfterStep, SideHead } from "../../../src/flow/builder-types.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import {
  PurchaseQuestionDto,
  SpendingLimitAnswerDto,
  SpendingLimitQuestion,
} from "../fixtures/questions.fixture.js";

/** #933 AC1: the side-path starter takes a question role only, and `.returns(AnswerDto)` follows it. */

@Agent({ name: "not-a-question-agent", description: "d", prompt: "p", model: "m" })
class NotAQuestionAgent {}

describe("#933 AC1: toQuestion types", () => {
  it("toExternalTask(Role) is an AfterStep of the role on a side path", () => {
    expectTypeOf(toExternalTask(SpendingLimitQuestion)).toEqualTypeOf<
      AfterStep<SpendingLimitQuestion, SideHead>
    >();
  });

  it(".returns(AnswerDto) follows it; another class does not", () => {
    toExternalTask(SpendingLimitQuestion).returns(SpendingLimitAnswerDto);
    // @ts-expect-error — the role gives SpendingLimitAnswerDto, not its ask
    toExternalTask(SpendingLimitQuestion).returns(PurchaseQuestionDto);
    // @ts-expect-error — an agent is not a question role
    toExternalTask(NotAQuestionAgent);
  });
});
