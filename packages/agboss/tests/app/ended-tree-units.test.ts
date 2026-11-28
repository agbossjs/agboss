import { usd } from "../../src/units/index.js";
/**
 * #633 (recovery shard) — a tree ended without a pass (`ended-tree.ts`) on its own: the call that
 * fails its record observes `onExecutionError` once, with what the undo ran — an empty list when it
 * ran nothing —, and a call that did not fail the record observes nothing; a lost run's call of
 * unknown cost (#860 D1) is kept with its record and tallied only by the call that failed it.
 */
import { describe, expect, it, vi } from "vitest";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { ExecutionStatus } from "../../src/app/types.js";
import type { AppDeps } from "../../src/app/app-deps.js";
import { endedWithoutPass, type EndedTreeParts } from "../../src/app/ended-tree.js";

vi.mock("../../src/app/compensation/root-unwind.js", () => ({
  markTreeUnwinding: () => Promise.resolve(),
}));
vi.mock("../../src/app/tree-unwind.js", () => ({
  undoneTreeEnd: (_deps: unknown, _state: unknown, failure: { error: Error }) =>
    Promise.resolve(failure.error),
}));
vi.mock("../../src/app/tree-ends.js", () => ({ forgetTree: () => Promise.resolve() }));
const kept = vi.hoisted(() => ({
  ends: [] as unknown[][],
  tallied: [] as unknown[][],
  lost: [] as unknown[],
}));
vi.mock("../../src/app/execution-history.js", () => ({
  keepExecutionRecord: () => Promise.resolve(),
  historyEndOf: (...args: unknown[]) => {
    kept.ends.push(args);
    return {};
  },
}));
vi.mock("../../src/app/lost-attempt.js", () => ({
  lostRunUsageOf: () => Promise.resolve(kept.lost),
  tallyLostRun: (...args: unknown[]) => {
    kept.tallied.push(args);
  },
}));
const shown = vi.hoisted((): { output: unknown } => ({ output: undefined }));
vi.mock("../../src/app/cancelled-output.js", () => ({
  cancelledOutputOf: () => Promise.resolve(shown.output),
}));
vi.mock("../../src/app/run-events.js", () => ({
  executionEventAt: () => ({ executionId: "root-1" }),
}));

const STATE = { runId: "root-1", threadId: "thread-1", tenantId: "acme", startedVersion: "1" };

function partsOf(isFailedHere: boolean, recordThread = "thread-1") {
  const onExecutionError = vi.fn(() => Promise.resolve());
  const record = {
    id: "tern-1",
    runId: "root-1",
    threadId: recordThread,
    route: [],
    costUsd: usd(0),
  };
  const findByTenantIdAndRunId = vi.fn(() => Promise.resolve(record));
  const completeIfStatus = vi.fn(() => Promise.resolve(isFailedHere));
  const onExecutionStop = vi.fn(() => Promise.resolve());
  const onExecutionCancel = vi.fn(() => Promise.resolve());
  const deps: AppDeps = {
    turns: { findByTenantIdAndRunId, completeIfStatus },
    observer: { onExecutionError, onExecutionStop, onExecutionCancel },
  } as never;
  const parts: EndedTreeParts = {
    deps,
    paused: { find: () => Promise.resolve(undefined), drop: vi.fn() },
  } as never;
  return {
    parts,
    onExecutionError,
    onExecutionStop,
    onExecutionCancel,
    findByTenantIdAndRunId,
    completeIfStatus,
  };
}

const end = () => ({
  cause: new Error("declined"),
  signal: new AbortController().signal,
  lease: {} as never,
});

describe("#633: endedWithoutPass", () => {
  it("an undo that ran nothing: onExecutionError lists no undo", async () => {
    const { parts, onExecutionError } = partsOf(true);

    const ended = await endedWithoutPass(parts, STATE, end());

    expect(ended.isEnded).toBe(true);
    expect(onExecutionError).toHaveBeenCalledWith(
      expect.objectContaining({ compensations: [], error: ended.error }),
    );
  });

  it("what the undo ran: listed as it ran", async () => {
    const { parts, onExecutionError } = partsOf(true);
    const compensations = [{ status: "compensated" }] as never;

    await endedWithoutPass(parts, STATE, { ...end(), undo: { compensations } });

    expect(onExecutionError).toHaveBeenCalledWith(expect.objectContaining({ compensations }));
  });

  it("#808: the root's record is found by its tenant and id, on its own thread", async () => {
    const { parts, findByTenantIdAndRunId } = partsOf(true);

    expect((await endedWithoutPass(parts, STATE, end())).isEnded).toBe(true);
    expect(findByTenantIdAndRunId).toHaveBeenCalledWith("acme", "root-1");
  });

  it("#808: a record of the run's id on another thread is not the tree's: nothing ended", async () => {
    const { parts, onExecutionError, completeIfStatus } = partsOf(true, "another-thread");

    expect((await endedWithoutPass(parts, STATE, end())).isEnded).toBe(false);
    expect(completeIfStatus).not.toHaveBeenCalled();
    expect(onExecutionError).not.toHaveBeenCalled();
  });

  it("the record ended by another call: nothing observed", async () => {
    const { parts, onExecutionError } = partsOf(false);

    expect((await endedWithoutPass(parts, STATE, end())).isEnded).toBe(false);
    expect(onExecutionError).not.toHaveBeenCalled();
  });

  it("#860 D1: a lost run's call of unknown cost goes with the record this call ended, tallied once", async () => {
    const lost = [{ caller: "lost-pass:w", costUsd: usd(0) }];
    kept.lost.splice(0, kept.lost.length, ...lost);
    kept.ends.length = 0;
    kept.tallied.length = 0;

    await endedWithoutPass(partsOf(true).parts, STATE, end());
    await endedWithoutPass(partsOf(false).parts, STATE, end());

    expect(kept.ends.map(([, , usage]) => usage)).toEqual([lost]);
    expect(kept.tallied.map(([, state, usage]) => [state, usage])).toEqual([[STATE, lost]]);
    kept.lost.length = 0;
  });

  it("a tree that ended by a cancel is observed as cancelled, with its undo, spend and reason — by no other observer", async () => {
    const { parts, onExecutionError, onExecutionStop, onExecutionCancel } = partsOf(true);
    shown.output = {
      status: ExecutionStatus.Cancelled,
      compensations: [{ status: "compensated" }],
      spend: { totalUsd: usd(1) },
      reason: "operator",
    };

    await endedWithoutPass(parts, STATE, { ...end(), cause: new ExecutionCancelledError() });

    expect(onExecutionCancel).toHaveBeenCalledWith({
      executionId: "root-1",
      compensations: [{ status: "compensated" }],
      spend: { totalUsd: usd(1) },
      reason: "operator",
    });
    expect(onExecutionStop).not.toHaveBeenCalled();
    expect(onExecutionError).not.toHaveBeenCalled();
    shown.output = undefined;
  });

  it("a tree that ended by a stop is observed as stopped, with its reason and spend only — by no other observer", async () => {
    const { parts, onExecutionError, onExecutionStop, onExecutionCancel } = partsOf(true);
    shown.output = {
      status: ExecutionStatus.Stopped,
      compensations: [],
      spend: { totalUsd: usd(2) },
      reason: "deploy",
    };

    await endedWithoutPass(parts, STATE, { ...end(), cause: new ExecutionCancelledError() });

    expect(onExecutionStop).toHaveBeenCalledWith({
      executionId: "root-1",
      reason: "deploy",
      spend: { totalUsd: usd(2) },
    });
    expect(onExecutionCancel).not.toHaveBeenCalled();
    expect(onExecutionError).not.toHaveBeenCalled();
    shown.output = undefined;
  });
});
