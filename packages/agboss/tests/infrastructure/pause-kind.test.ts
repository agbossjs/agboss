/**
 * 0.1.1 (#801): a pause's kind is one of the two, and a question's ask an object — anything else
 * fails loudly where it is read, never taken for an approval or branded as an ask.
 */
import { describe, expect, it } from "vitest";
import { PauseKind, questionAskOf } from "../../src/infrastructure/pause-kind.js";
import {
  isApprovalPause,
  isQuestionPause,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { pauseOf, questionPauseOf } from "../../src/testing/contracts/paused-execution-data.js";

describe("#801: a pause's kind", () => {
  it("tells a question from an approval by kind", () => {
    expect(isQuestionPause(questionPauseOf("q"))).toBe(true);
    expect(isApprovalPause(pauseOf("a"))).toBe(true);
    expect(isQuestionPause({ kind: PauseKind.Approval, pauseId: "a" })).toBe(false);
  });

  it("a kind a store did not keep throws, naming the pause — never an approval", () => {
    // as a store that does not keep `kind` reads it back (JSON drops it)
    const { kind, ...kept } = questionPauseOf("q-lost");
    const lost = JSON.parse(JSON.stringify(kept)) as PauseRecord;
    expect(kind).toBe(PauseKind.Question);

    expect(() => isApprovalPause(lost)).toThrow(/pause q-lost: kind undefined is no PauseKind/);
    expect(() => isQuestionPause({ kind: "approve" as PauseKind, pauseId: "x" })).toThrow(
      TypeError,
    );
  });
});

describe("#801: questionAskOf", () => {
  it("brands an object as it is", () => {
    const ask = { item: "laptop" };
    expect(questionAskOf(ask)).toBe(ask);
  });

  it.each([null, undefined, "laptop", 7, ["laptop"]])("refuses %j", (value) => {
    expect(() => questionAskOf(value)).toThrow(TypeError);
  });
});
