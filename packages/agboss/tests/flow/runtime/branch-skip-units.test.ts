import { A2AError } from "../../../src/core/error-families/a2a-errors.js";
import { ExecutionError } from "../../../src/core/error-families/run-errors.js";
import {
  GuardrailError,
  LimitError,
  PiiError,
} from "../../../src/core/error-families/limit-errors.js";
import { StepError } from "../../../src/core/error-families/step-errors.js";
import { describe, expect, it } from "vitest";
import { AGBossError } from "../../../src/core/errors.js";
import { BranchStatus } from "../../../src/flow/runtime/launch/records.js";
import { failedStatusOf } from "../../../src/flow/runtime/launch/branch-end.js";
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

describe("#1325b: skip(StepError) drops step failures only", () => {
  const skip = { skip: skipCodesOf([StepError]) };

  it("drops an action's failure with a remote agent's error as its cause", () => {
    const remote = new A2AError.TaskFailed({
      agent: "billing-a2a-agent",
      taskId: "t",
      contextId: "c",
      end: "failed" as never,
    });

    expect(isSkippedBranch(skip, new StepError.Action({ action: "x-action", cause: remote }))).toBe(
      true,
    );
  });

  it("never drops a limit, a guardrail, a PII refusal, a cancelled write or a remote error that is no step's", () => {
    const place = { path: [], spentUsd: 0 as never };
    const others = [
      new LimitError.Agent({ key: "k", limit: 1, actual: 2, ...place }),
      new GuardrailError.Blocked({ guardrail: "g", refusal: "r", probability: 1, threshold: 0.5 }),
      new PiiError.Refused({ piiKind: "email", refusal: "r" }),
      new ExecutionError.CancelFenced(),
      new A2AError.Unavailable(),
    ];

    for (const error of others) expect(isSkippedBranch(skip, error), error.name).toBe(false);
  });
});

describe("#1325b: a branch whose action called a remote agent that failed", () => {
  const site = (isQuorum: boolean) =>
    ({ live: { controller: new AbortController() }, ticket: {}, isQuorum }) as never;
  const remote = new A2AError.TaskFailed({
    agent: "billing-a2a-agent",
    taskId: "t",
    contextId: "c",
    end: "failed" as never,
  });
  const wrapped = new StepError.Action({ action: "x-action", cause: remote });

  it("under a quorum leaves its place empty, as any step failure does", () => {
    expect(failedStatusOf(site(true), wrapped)).toBe(BranchStatus.Skipped);
  });

  it("without a quorum or a skip() fails the launch", () => {
    expect(failedStatusOf(site(false), wrapped)).toBe(BranchStatus.Failed);
  });
});
