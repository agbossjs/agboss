import { describe, expectTypeOf, it } from "vitest";
import {
  PauseKind,
  type PauseRecord,
  type PendingApproval,
  type PendingPause,
  type PendingPauseBase,
  type PendingQuestion,
  type PauseToolCallSummary,
} from "../../src/index.js";
import type { PauseTrailRecord } from "../../src/infrastructure/pause-record.js";
import { QuestionFailedError } from "../../src/errors.js";

/**
 * The pause contract's types (#1307d): a pending pause says what it asks (`input`, an object, whatever
 * its kind) and, for an approval, the call it waits on (`toolCall`, read after narrowing on `kind`).
 */

declare const pending: readonly PendingPause[];

describe("AC1: a PendingPause is what it asks (`input`) and, for an approval, the call (`toolCall`)", () => {
  it("`input` is an object on every pending pause, whatever its kind", () => {
    const first = pending[0];
    if (first === undefined) return;
    expectTypeOf(first.input).toEqualTypeOf<Readonly<Record<string, unknown>>>();
    // @ts-expect-error — 0.1.0's `ask` is gone: `input` and `toolCall`
    void first.ask;
  });

  it("an approval keeps its call after narrowing on `kind`", () => {
    const first = pending[0];
    if (first?.kind !== PauseKind.Approval) return;
    expectTypeOf(first).toEqualTypeOf<PendingApproval>();
    expectTypeOf(first.toolCall).toEqualTypeOf<PauseToolCallSummary>();
    expectTypeOf(first.toolCall.tool).toEqualTypeOf<string>();
  });

  it("a question has no tool call", () => {
    const first = pending[0];
    if (first?.kind !== PauseKind.Question) return;
    expectTypeOf(first).toEqualTypeOf<PendingQuestion>();
    expectTypeOf(first).not.toHaveProperty("toolCall");
  });

  it("who it is for, its external reference and its chain of custody are on every pending pause", () => {
    expectTypeOf<PendingPauseBase["assignees"]>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<PendingPauseBase["externalRef"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<PendingPauseBase["trail"]>().toEqualTypeOf<readonly PauseTrailRecord[]>();
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
      [options: { readonly question: string; readonly cause?: unknown }]
    >();
  });
});
