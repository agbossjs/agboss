import { describe, expect, it } from "vitest";
import { AGBossError } from "../../../src/core/errors.js";
import { FailurePolicy } from "../../../src/flow/decorators/router.js";
import { isSkippedBranch, skipCodesOf } from "../../../src/flow/runtime/launch/branch-skip.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { errorRecordOf } from "../../../src/core/error-record.js";

/** #1279a: which failures drop a branch out of its join. */

class DomainError extends AGBossError {
  static override readonly code: string = "test.domain";
}

const failedStep = (): Error =>
  new StepFailedError({
    message: "x",
    usage: [],
    component: { name: "a-action", kind: "action", promptHash: "", schemaHash: "" },
    nodeId: "a-action",
    visitNumber: 1,
    itemIndex: undefined,
  } as never);

describe("#1279a: isSkippedBranch", () => {
  it("a branch with no skip() and FailFast is never skipped", () => {
    expect(isSkippedBranch({ failure: FailurePolicy.FailFast }, failedStep())).toBe(false);
    expect(isSkippedBranch({ failure: FailurePolicy.FailFast, skip: [] }, failedStep())).toBe(
      false,
    );
  });

  it("a router route's Skip drops any failure the runner lets through", () => {
    expect(isSkippedBranch({ failure: FailurePolicy.Skip }, failedStep())).toBe(true);
  });

  it("skip(E) drops a failure of E's class, its subclasses, and one caused by it", () => {
    const skip = skipCodesOf([StepFailedError]);
    expect(isSkippedBranch({ failure: FailurePolicy.FailFast, skip }, failedStep())).toBe(true);
    const caused = new Error("outer", { cause: new DomainError("inner") });
    expect(
      isSkippedBranch(
        { failure: FailurePolicy.FailFast, skip: skipCodesOf([DomainError]) },
        caused,
      ),
    ).toBe(true);
    expect(
      isSkippedBranch(
        { failure: FailurePolicy.FailFast, skip: skipCodesOf([DomainError]) },
        failedStep(),
      ),
    ).toBe(false);
  });

  it("reads a recorded error as well as a thrown one", () => {
    const record = errorRecordOf(new DomainError("x"));
    expect(
      isSkippedBranch(
        { failure: FailurePolicy.FailFast, skip: skipCodesOf([DomainError]) },
        record,
      ),
    ).toBe(true);
    expect(
      isSkippedBranch(
        { failure: FailurePolicy.FailFast, skip: skipCodesOf([StepFailedError]) },
        record,
      ),
    ).toBe(false);
  });

  it("Error catches every failure", () => {
    expect(skipCodesOf([Error])).toEqual(["*"]);
    expect(
      isSkippedBranch(
        { failure: FailurePolicy.FailFast, skip: skipCodesOf([Error]) },
        new TypeError("x"),
      ),
    ).toBe(true);
  });
});
