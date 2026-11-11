import { describe, expectTypeOf, it } from "vitest";
import {
  PauseKind,
  type PauseRecord,
  type PendingApproval,
  type PendingPause,
  type PendingPauseBase,
  type PendingQuestion,
  type QuestionAsk,
  type ToolCallApprovalAskDto,
} from "../../src/index.js";
import { QuestionFailedError } from "../../src/errors.js";

/**
 * The pause contract's types (0.1.1 API review, Part 5): a question's ask is opaque, so a field of
 * a `PendingPause`'s ask is read only after narrowing on `kind`; an approval's keeps its typing.
 */

declare const pending: readonly PendingPause[];

describe("AC1: a PendingPause's ask is read only after narrowing on kind", () => {
  it("a field of the ask without narrowing does not compile", () => {
    const first = pending[0];
    if (first === undefined) return;
    // @ts-expect-error — a question's ask has no `arguments`: narrow on `kind` first
    expectTypeOf(first.ask.arguments).toBeUnknown();
    // @ts-expect-error — nor any other field
    expectTypeOf(first.ask.tool).toBeString();
  });

  it("an approval keeps its full typing after narrowing", () => {
    const first = pending[0];
    if (first?.kind !== PauseKind.Approval) return;
    expectTypeOf(first).toEqualTypeOf<PendingApproval>();
    expectTypeOf(first.ask).toEqualTypeOf<ToolCallApprovalAskDto>();
    expectTypeOf(first.ask.arguments).not.toBeUnknown();
    expectTypeOf(first.ask.arguments).toEqualTypeOf<ToolCallApprovalAskDto["arguments"]>();
    expectTypeOf(first.ask.tool).toEqualTypeOf<string>();
  });

  it("a question's ask stays opaque after narrowing, readable as a record", () => {
    const first = pending[0];
    if (first?.kind !== PauseKind.Question) return;
    expectTypeOf(first).toEqualTypeOf<PendingQuestion>();
    expectTypeOf(first.ask).toEqualTypeOf<QuestionAsk>();
    // @ts-expect-error — opaque: the role's ask is not typed by the pause
    expectTypeOf(first.ask.item).toBeUnknown();
    expectTypeOf(first.ask).toExtend<Readonly<Record<string, unknown>>>();
  });

  it("a plain record is not a question's ask", () => {
    expectTypeOf<Readonly<Record<string, unknown>>>().not.toExtend<QuestionAsk>();
  });
});

describe("AC3: the pause's step, and the base of a pending pause", () => {
  it("names the step that asks, not an agent", () => {
    expectTypeOf<PendingPauseBase["step"]>().toEqualTypeOf<string>();
    expectTypeOf<PauseRecord["step"]>().toEqualTypeOf<string>();
    expectTypeOf<PendingPauseBase>().not.toHaveProperty("agent");
    expectTypeOf<PauseRecord>().not.toHaveProperty("agent");
    expectTypeOf<PendingApproval>().toExtend<PendingPauseBase>();
    expectTypeOf<PendingQuestion>().toExtend<PendingPauseBase>();
  });

  it("a stored pause says its kind", () => {
    expectTypeOf<PauseRecord["kind"]>().toEqualTypeOf<PauseKind>();
  });
});

describe("AC3: QuestionFailedError names its question", () => {
  it("takes one options object, its cause in it (#890); its code is a literal", () => {
    expectTypeOf(QuestionFailedError.code).toEqualTypeOf<"step.question">();
    expectTypeOf<QuestionFailedError["question"]>().toEqualTypeOf<string>();
    expectTypeOf(QuestionFailedError).constructorParameters.toEqualTypeOf<
      [options: { readonly question: string; readonly cause: unknown }]
    >();
  });
});
