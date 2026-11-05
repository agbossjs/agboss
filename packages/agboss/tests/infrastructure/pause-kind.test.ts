/**
 * 0.1.1 (#801): a pause's kind is one of the two, and a question's ask an object — anything else
 * fails loudly where it is read, never taken for an approval or branded as an ask.
 */
import { describe, expect, it } from "vitest";
import { PauseKind, questionAskOf } from "../../src/infrastructure/pause-kind.js";
import { isApprovalPause, isQuestionPause } from "../../src/infrastructure/pause-record.js";
import { pauseOf, questionPauseOf } from "../../src/testing/contracts/paused-execution-data.js";

describe("#801: a pause's kind", () => {
  it("tells a question from an approval by kind", () => {
    expect(isQuestionPause(questionPauseOf("q"))).toBe(true);
    expect(isApprovalPause(pauseOf("a"))).toBe(true);
    expect(isQuestionPause({ kind: PauseKind.Approval, pauseId: "a" })).toBe(false);
  });

  it("a kind a store did not keep throws, naming the pause — never an approval", () => {
    const lost = { ...questionPauseOf("q-lost"), kind: undefined as unknown as PauseKind };

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
