import { StepError } from "../../../src/core/error-families/step-errors.js";
import { describe, expect, it } from "vitest";
import { AGBossError } from "../../../src/core/errors.js";
import { isSkippedBranch, skipCodesOf } from "../../../src/flow/runtime/launch/branch-skip.js";
import { errorRecordOf } from "../../../src/core/error-record.js";

/** #1279a: which failures drop a branch out of its join. */

class DomainError extends AGBossError {
  static override readonly code: string = "test.domain";
}

const failedStep = (): Error =>
  new StepError.Agent({
    agent: "x",
    message: "x",
    usage: [],
    component: { name: "a-action", kind: "action", promptHash: "", schemaHash: "" },
    nodeId: "a-action",
    visitNumber: 1,
    itemIndex: undefined,
  } as never);

describe("#1279a: isSkippedBranch", () => {
  it("a branch with no skip() is never skipped", () => {
    expect(isSkippedBranch({}, failedStep())).toBe(false);
    expect(isSkippedBranch({ skip: [] }, failedStep())).toBe(false);
  });

  it("skip(E) drops a failure of E's class, its subclasses, and one caused by it", () => {
    const skip = skipCodesOf([StepError]);
    expect(isSkippedBranch({ skip }, failedStep())).toBe(true);
    const caused = new Error("outer", { cause: new DomainError("inner") });
    expect(isSkippedBranch({ skip: skipCodesOf([DomainError]) }, caused)).toBe(true);
    expect(isSkippedBranch({ skip: skipCodesOf([DomainError]) }, failedStep())).toBe(false);
  });

  it("reads a recorded error as well as a thrown one", () => {
    const record = errorRecordOf(new DomainError("x"));
    expect(isSkippedBranch({ skip: skipCodesOf([DomainError]) }, record)).toBe(true);
    expect(isSkippedBranch({ skip: skipCodesOf([StepError]) }, record)).toBe(false);
  });

  it("Error catches every failure", () => {
    expect(skipCodesOf([Error])).toEqual(["*"]);
    expect(isSkippedBranch({ skip: skipCodesOf([Error]) }, new TypeError("x"))).toBe(true);
  });
});
