import { fencedRefusalOf } from "../../../src/app/lease-lost.js";
/**
 * #1366 (shard `cancel-x-runs`): how a branch that threw ends (`branch-end.ts`) — cancelled when its launch was
 * aborted or its pause withdrawn, a hand-over and a cancel of the execution passed through as they are, the
 * failures kept for the join and forgotten with the launch or the execution.
 */
import { describe, expect, it } from "vitest";
import { ExecutionCancelledError } from "../../../src/core/errors.js";
import { newRunContext } from "../../../src/core/run-context.js";
import { ExecutionLeaseLostError } from "../../../src/app/lease-lost.js";
import { PauseExpiredError } from "../../../src/flow/runtime/pause-expired-error.js";
import { PauseWithdrawnError } from "../../../src/flow/runtime/pause.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { LimitExceededError } from "../../../src/graph/limits.js";
import { FailurePolicy } from "../../../src/flow/decorators/router.js";
import { ArbiterError } from "../../../src/flow/runtime/launch/quorum-errors.js";
import {
  BranchErrors,
  branchRecordOf,
  executionSignalOf,
  failedStatusOf,
  failureOfBranch,
  passThroughStops,
} from "../../../src/flow/runtime/launch/branch-end.js";
import { BranchStatus } from "../../../src/flow/runtime/launch/records.js";

const stepFailed = (): Error => Object.create(StepFailedError.prototype) as Error;
const arbiterFailed = (): Error => Object.create(ArbiterError.prototype) as Error;
const expired = (): Error => Object.create(PauseExpiredError.prototype) as Error;

function siteOf(options: { aborted?: boolean; failure?: FailurePolicy; isQuorum?: boolean } = {}) {
  const controller = new AbortController();
  if (options.aborted === true) controller.abort();
  return {
    live: { controller },
    ticket: { failure: options.failure ?? FailurePolicy.FailFast },
    isQuorum: options.isQuorum ?? false,
  } as never;
}

describe("#1366: the status of a branch that threw", () => {
  it("a pause that expired is the branch's own outcome, though its launch was aborted by then", () => {
    expect(failedStatusOf(siteOf({ aborted: true }), expired())).toBe(BranchStatus.Expired);
    expect(failedStatusOf(siteOf(), expired())).toBe(BranchStatus.Expired);
  });

  it("a launch aborted first, or a pause withdrawn (also through a cause): cancelled", () => {
    expect(failedStatusOf(siteOf({ aborted: true }), new Error("x"))).toBe(BranchStatus.Cancelled);
    expect(failedStatusOf(siteOf({ aborted: true }), stepFailed())).toBe(BranchStatus.Cancelled);
    const withdrawn = new PauseWithdrawnError({ message: "withdrawn" });
    expect(failedStatusOf(siteOf(), withdrawn)).toBe(BranchStatus.Cancelled);
    expect(failedStatusOf(siteOf(), new Error("wrapped", { cause: withdrawn }))).toBe(
      BranchStatus.Cancelled,
    );
  });

  it("an arbiter's error, or anything that is no step failure: failed — whatever the policy", () => {
    expect(failedStatusOf(siteOf({ failure: FailurePolicy.Skip }), arbiterFailed())).toBe(
      BranchStatus.Failed,
    );
    expect(failedStatusOf(siteOf({ isQuorum: true }), arbiterFailed())).toBe(BranchStatus.Failed);
    expect(failedStatusOf(siteOf({ failure: FailurePolicy.Skip }), new Error("a limit"))).toBe(
      BranchStatus.Failed,
    );
    expect(failedStatusOf(siteOf({ isQuorum: true }), "plain text")).toBe(BranchStatus.Failed);
  });

  it("a step failure: skipped under Skip or in a quorum, else failed", () => {
    expect(failedStatusOf(siteOf({ failure: FailurePolicy.Skip }), stepFailed())).toBe(
      BranchStatus.Skipped,
    );
    expect(failedStatusOf(siteOf({ isQuorum: true }), stepFailed())).toBe(BranchStatus.Skipped);
    expect(failedStatusOf(siteOf(), stepFailed())).toBe(BranchStatus.Failed);
  });
});

describe("#1366: the stops that are no outcome of a branch", () => {
  const lost = () => new ExecutionLeaseLostError({ rootExecutionId: "root-1" });

  it("the execution's own signal is the run's; without a run on the config, the config's signal", () => {
    const run = newRunContext({ runId: "exec-1" });

    expect(executionSignalOf({ configurable: { run } }, "exec-1")).toBe(run.signal);
    const own = new AbortController();
    expect(executionSignalOf({ signal: own.signal }, "exec-1")).toBe(own.signal);
    expect(executionSignalOf(undefined, "exec-1").aborted).toBe(false);
  });

  it("nothing stopped: nothing thrown", () => {
    expect(() => {
      passThroughStops({ configurable: { run: newRunContext({ runId: "exec-1" }) } }, "exec-1");
    }).not.toThrow();
    expect(() => {
      passThroughStops(undefined, "exec-1", new Error("a branch's own failure"));
    }).not.toThrow();
  });

  it("the execution cancelled: thrown as a cancel of the launch, whichever signal says so", () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const byRun = {
      configurable: { run: newRunContext({ runId: "exec-1", signal: cancelled.signal }) },
    };
    const byCall = { signal: cancelled.signal };

    for (const config of [byRun, byCall]) {
      const thrown = (() => {
        try {
          passThroughStops(config, "exec-1");
        } catch (error) {
          return error;
        }
        return undefined;
      })();
      expect(thrown).toBeInstanceOf(ExecutionCancelledError);
      expect((thrown as Error).message).toBe(
        "the execution was cancelled during a parallel launch",
      );
    }
  });

  it("the call's own signal aborted, though the run's is not: the same cancel", () => {
    const own = new AbortController();
    own.abort();
    const config = {
      signal: own.signal,
      configurable: { run: newRunContext({ runId: "exec-1" }) },
    };

    expect(() => {
      passThroughStops(config, "exec-1");
    }).toThrow(ExecutionCancelledError);
  });

  it("a hand-over (the lease lost, found in the call's signal) is thrown as it is, before a cancel", () => {
    const stop = new AbortController();
    const reason = lost();
    stop.abort(reason);

    expect(() => {
      passThroughStops({ signal: stop.signal }, "exec-1");
    }).toThrow(reason);
  });

  it("a fenced write behind the branch's error is a hand-over: it is the one thrown, before the cancel the signal says", () => {
    const stop = new AbortController();
    stop.abort(new ExecutionCancelledError({ message: "cancelled" }));
    const fenced = fencedRefusalOf({ scopeKey: "acme:root-1", token: 1, observedToken: 2 });

    expect(() => {
      passThroughStops({ signal: stop.signal }, "exec-1", new Error("wrapped", { cause: fenced }));
    }).toThrow(fenced);
  });

  it("an error that is no hand-over leaves the decision to the signal: a cancel", () => {
    const stop = new AbortController();
    stop.abort(new ExecutionCancelledError({ message: "cancelled" }));

    expect(() => {
      passThroughStops({ signal: stop.signal }, "exec-1", new Error("wrapped", { cause: lost() }));
    }).toThrow(ExecutionCancelledError);
  });
});

describe("#1366: the record of a branch and the errors kept for the join", () => {
  it("the record: launch, index, status, what was read — a value, an error or a mark only when there is one", () => {
    expect(branchRecordOf("launch-1", 2, { status: BranchStatus.Cancelled, read: ["a"] })).toEqual({
      launchId: "launch-1",
      index: 2,
      status: BranchStatus.Cancelled,
      read: ["a"],
    });
    const full = branchRecordOf("launch-1", 0, {
      status: BranchStatus.Finished,
      value: { k: 1 } as never,
      read: [],
      error: { message: "e" } as never,
      mark: { voted: true } as never,
    });
    expect(full).toMatchObject({ value: { k: 1 }, error: { message: "e" }, voted: true });
    const bare = branchRecordOf("launch-1", 2, { status: BranchStatus.Cancelled, read: ["a"] });
    expect("value" in bare).toBe(false);
    expect("error" in bare).toBe(false);
    expect(Object.keys(bare).sort()).toEqual(["index", "launchId", "read", "status"]);
  });

  it("an error is found as it was thrown, by launch and index; unknown is undefined", () => {
    const errors = new BranchErrors();
    const boom = new Error("boom");
    errors.keep("launch-1", 3, boom);

    expect(errors.find("launch-1", 3)).toBe(boom);
    expect(errors.find("launch-1", 2)).toBeUndefined();
    expect(errors.find("launch-2", 3)).toBeUndefined();
  });

  it("a launch's errors go with its join, another launch's whose id starts the same stay", () => {
    const errors = new BranchErrors();
    errors.keep("exec:1", 0, "a");
    errors.keep("exec:1", 1, "b");
    errors.keep("exec:10", 0, "c");

    errors.forgetLaunch("exec:1");

    expect(errors.find("exec:1", 0)).toBeUndefined();
    expect(errors.find("exec:1", 1)).toBeUndefined();
    expect(errors.find("exec:10", 0)).toBe("c");
  });

  it("an execution's errors go with its tree; a launch id starts with the execution's id and a colon", () => {
    const errors = new BranchErrors();
    errors.keep("exec-1:launch-a", 0, "a");
    errors.keep("exec-1:launch-b", 1, "b");
    errors.keep("exec-10:launch-a", 0, "c");
    errors.keep("exec-1", 0, "d");

    errors.forgetExecution("exec-1");

    expect(errors.find("exec-1:launch-a", 0)).toBeUndefined();
    expect(errors.find("exec-1:launch-b", 1)).toBeUndefined();
    expect(errors.find("exec-10:launch-a", 0)).toBe("c");
    expect(errors.find("exec-1", 0)).toBe("d");
  });

  it("a branch stopped by an exhausted budget fails with the budget's error, whatever it surfaced as; its own limit stays", () => {
    const stop = new AbortController();
    const budget = new Error("budget");
    stop.abort(budget);
    const limit: Error = Object.create(LimitExceededError.prototype);
    const other = new Error("surfaced as");

    expect(failureOfBranch(stop.signal, other)).toBe(budget);
    expect(failureOfBranch(stop.signal, limit)).toBe(limit);
    expect(failureOfBranch(new AbortController().signal, other)).toBe(other);
    expect(failureOfBranch(undefined, other)).toBe(other);
  });
});
