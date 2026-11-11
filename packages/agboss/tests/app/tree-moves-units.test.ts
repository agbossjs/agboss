/**
 * #633 (recovery shard) — moving a tree (`tree-moves.ts`) on its own, every collaborator scripted:
 * the sweep leaves a root a resume of this instance moves, a take that ends the tree (a cancel, an
 * undo under way) runs no pass, a recovery whose record ended meanwhile gives its lease back, and
 * the drain takes each pass's answers once, looks for more only while the tree rests paused and
 * forgets the tree only when it finished.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotPausedError } from "../../src/run/resume-agent.js";
import type { HeldExecutionLease } from "../../src/app/execution-leases.js";
import type { RecordedAnswer } from "../../src/app/resume.js";
import { treeMovesOf, type TreeMoveParts } from "../../src/app/tree-moves.js";
import { ExecutionStatus, type ExecutionOutput } from "../../src/app/types.js";
import type { InterruptedRun } from "../../src/run/continue-agent.js";
import type { TreeResume } from "../../src/run/resume-map.js";

const mocks = vi.hoisted(() => ({
  endIfCancelled: vi.fn(),
  endedAtTake: vi.fn(),
  endIfCancelledAtRest: vi.fn(),
  endedUnwindingAtTake: vi.fn(),
  endUnwindingIfFree: vi.fn(),
  isUnwinding: vi.fn(),
  treeResumeNow: vi.fn(),
  markTaken: vi.fn(),
  observedPass: vi.fn(),
  currentOutputOf: vi.fn(),
  forgetTree: vi.fn(),
  passEnded: vi.fn(),
  recoveryPassOf: vi.fn(),
  withTreeOrigin: vi.fn(),
}));

vi.mock("../../src/app/cancel-requests.js", () => ({
  endIfCancelled: mocks.endIfCancelled,
  endedAtTake: mocks.endedAtTake,
  endIfCancelledAtRest: mocks.endIfCancelledAtRest,
  cancelWatchOf: () => ({ check: () => Promise.resolve() }),
}));
vi.mock("../../src/app/unwinding-takeover.js", () => ({
  endedUnwindingAtTake: mocks.endedUnwindingAtTake,
  endUnwindingIfFree: mocks.endUnwindingIfFree,
}));
vi.mock("../../src/flow/runtime/compensation/unwinding-marks.js", () => ({
  isUnwinding: mocks.isUnwinding,
}));
vi.mock("../../src/app/tree-resume.js", () => ({
  treeResumeNow: mocks.treeResumeNow,
  markTaken: mocks.markTaken,
  announceResume: () => Promise.resolve(),
  // #853: no lost passes to carry — the call as it is
  callWithLostPasses: (_parts: unknown, _state: unknown, call: unknown) => Promise.resolve(call),
}));
vi.mock("../../src/app/observed-pass.js", () => ({ observedPass: mocks.observedPass }));
// the current output scripted; a resume's refusal of a failed root (#901) as it is
vi.mock("../../src/app/current-output.js", async (actual) => ({
  ...(await actual<typeof import("../../src/app/current-output.js")>()),
  currentOutputOf: mocks.currentOutputOf,
}));
vi.mock("../../src/app/result.js", () => ({
  withPauseAnswers: (result: unknown) => Promise.resolve(result),
}));
vi.mock("../../src/app/execution-history.js", () => ({
  keepExecutionRecord: () => Promise.resolve(),
  historyRestOf: () => ({}),
  historyEndOf: () => ({}),
}));
vi.mock("../../src/app/run-events.js", () => ({ executionEventAt: () => ({}) }));
vi.mock("../../src/app/tree-origin.js", () => ({ withTreeOrigin: mocks.withTreeOrigin }));
vi.mock("../../src/app/tree-ends.js", () => ({
  forgetTree: mocks.forgetTree,
  passEnded: mocks.passEnded,
  treeOf: (state: { tenantId: string; runId: string }) => ({
    tenantId: state.tenantId,
    rootExecutionId: state.runId,
  }),
}));
vi.mock("../../src/app/recovery-pass.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/recovery-pass.js")>()),
  recoveryPassOf: mocks.recoveryPassOf,
}));

const ROOT = "root-1";
const INTERRUPTED: InterruptedRun = {
  runId: ROOT,
  threadId: "thread-1",
  tenantId: "acme",
  ternId: "tern-1",
  startedVersion: "1.0.0",
};

const output = (status: ExecutionStatus): ExecutionOutput =>
  ({ status, executionId: ROOT }) as never;

const resumeOf = (...pauseIds: string[]): TreeResume => ({
  values: {},
  pauseIds,
  taken: [],
  decisions: [],
  answerers: [],
});

/** A held lease that records its release. */
function leaseOf(): HeldExecutionLease & { readonly released: () => number } {
  let released = 0;
  return {
    release: () => {
      released += 1;
      return Promise.resolve();
    },
    afterEachRenewal: () => undefined,
    released: () => released,
  } as never;
}

function partsOf(lease = leaseOf()) {
  const warn = vi.fn();
  const leases = {
    hold: vi.fn(() => Promise.resolve(lease)),
    tryHold: vi.fn(() => Promise.resolve(lease)),
  };
  const paused = { find: vi.fn(() => Promise.resolve(undefined)), drop: vi.fn() };
  const findByTenantIdAndRunId = vi.fn<() => Promise<unknown>>(() => Promise.resolve(undefined));
  const parts: TreeMoveParts = {
    deps: {
      config: { version: "2.0.0", name: "desk-workflow" },
      terns: {
        completeIfStatus: vi.fn(() => Promise.resolve(true)),
        findByTenantIdAndRunId,
      },
      pause: undefined,
      log: { warn },
    },
    live: { moving: <T>(move: Promise<T>) => move },
    paused,
    leases,
    trees: {},
    clock: {},
  } as never;
  const terns = { findByTenantIdAndRunId };
  return { parts, lease, leases, paused, warn, terns, moves: treeMovesOf(parts) };
}

const call = { signal: new AbortController().signal } as never;

const answerOf = (startedVersion?: string): RecordedAnswer =>
  ({
    pause: { rootExecutionId: ROOT, threadId: "thread-1", tenantId: "acme" },
    run:
      startedVersion === undefined
        ? undefined
        : { startedVersion, ternId: "tern-1", path: [], cost: { totalUsd: 0 } },
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.endIfCancelled.mockResolvedValue(false);
  mocks.endedAtTake.mockResolvedValue(undefined);
  mocks.endIfCancelledAtRest.mockResolvedValue(undefined);
  mocks.isUnwinding.mockResolvedValue(false);
  mocks.treeResumeNow.mockResolvedValue(undefined);
  mocks.markTaken.mockResolvedValue(undefined);
  mocks.observedPass.mockResolvedValue(output(ExecutionStatus.Finished));
  mocks.currentOutputOf.mockResolvedValue(output(ExecutionStatus.Paused));
  mocks.forgetTree.mockResolvedValue(undefined);
  mocks.passEnded.mockResolvedValue(undefined);
  mocks.recoveryPassOf.mockResolvedValue({ pass: () => Promise.resolve() });
  mocks.withTreeOrigin.mockImplementation((_deps: unknown, state: unknown) =>
    Promise.resolve(state),
  );
});

describe("#633: the sweep leaves a root a resume of this instance moves", () => {
  it("while a resume waits for the tree's lease: no take, no end — and once it left, both again", async () => {
    const { moves, leases } = partsOf();
    let give = (): void => undefined;
    leases.hold.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          give = () => {
            resolve(leaseOf());
          };
        }),
    );
    mocks.endedAtTake.mockResolvedValueOnce(new Error("cancelled at the take"));
    const resuming = moves.resumed(answerOf("1.0.0"), call);
    await vi.waitFor(() => {
      expect(leases.hold).toHaveBeenCalledOnce();
    });

    const whileBusy = [
      await moves.recovered(INTERRUPTED, call),
      await moves.endIfEnding(INTERRUPTED),
    ];
    const takesWhileBusy = leases.tryHold.mock.calls.length;
    const endsWhileBusy = mocks.endIfCancelled.mock.calls.length;
    give();
    await expect(resuming).rejects.toThrow("cancelled at the take");
    await moves.recovered(INTERRUPTED, call);

    expect(whileBusy).toEqual([undefined, false]);
    expect({ takesWhileBusy, endsWhileBusy }).toEqual({ takesWhileBusy: 0, endsWhileBusy: 0 });
    expect(leases.tryHold).toHaveBeenCalledOnce();
  });

  it("a resume starts from the version its run started on; with no run yet, this one's", async () => {
    const { moves } = partsOf();
    mocks.endedAtTake.mockResolvedValue(new Error("ended"));

    await moves.resumed(answerOf("0.9.0"), call).catch(() => undefined);
    await moves.resumed(answerOf(), call).catch(() => undefined);

    const versions = mocks.withTreeOrigin.mock.calls.map(
      ([, state]) => (state as { startedVersion: string }).startedVersion,
    );
    expect(versions).toEqual(["0.9.0", "2.0.0"]);
  });
});

describe("#633: a recovery's take", () => {
  it("ended at the take by a cancel: no pass, nothing recovered", async () => {
    const { moves } = partsOf();
    mocks.endedAtTake.mockResolvedValue(new Error("cancelled"));
    // an undo under way too: the cancel's end is the one
    mocks.isUnwinding.mockResolvedValue(true);

    expect(await moves.recovered(INTERRUPTED, call)).toBeUndefined();
    expect(mocks.recoveryPassOf).not.toHaveBeenCalled();
    expect(mocks.endedUnwindingAtTake).not.toHaveBeenCalled();
  });

  it("an undo under way: finished at the take, no pass", async () => {
    const { moves } = partsOf();
    mocks.isUnwinding.mockResolvedValue(true);
    mocks.endedUnwindingAtTake.mockResolvedValue(new Error("undone"));

    expect(await moves.recovered(INTERRUPTED, call)).toBeUndefined();
    expect(mocks.endedUnwindingAtTake).toHaveBeenCalledOnce();
    expect(mocks.recoveryPassOf).not.toHaveBeenCalled();
  });

  it("its record ended meanwhile: the lease given back, nothing recovered nor logged", async () => {
    const { moves, lease, warn } = partsOf();
    mocks.recoveryPassOf.mockResolvedValue(undefined);

    expect(await moves.recovered(INTERRUPTED, call)).toBeUndefined();
    expect({ released: lease.released(), warned: warn.mock.calls.length }).toEqual({
      released: 1,
      warned: 0,
    });
    expect(mocks.observedPass).not.toHaveBeenCalled();
  });

  it("its pass cannot be read: the lease given back, the error thrown", async () => {
    const { moves, lease } = partsOf();
    mocks.recoveryPassOf.mockRejectedValue(new Error("checkpoint unreadable"));

    await expect(moves.recovered(INTERRUPTED, call)).rejects.toThrow("checkpoint unreadable");
    expect(lease.released()).toBe(1);
  });

  it("recovered: logged with the execution and its tenant, then moved", async () => {
    const { moves, warn } = partsOf();

    expect(await moves.recovered(INTERRUPTED, call)).toMatchObject({
      status: ExecutionStatus.Finished,
    });
    expect(warn).toHaveBeenCalledWith(
      "execution.recovered",
      "execution root-1 is recovered: it continues from its last checkpoint",
      { executionId: ROOT, tenantId: "acme" },
    );
  });
});

describe("#633: a root that is ending", () => {
  it("a cancel request: ended, true", async () => {
    const { moves } = partsOf();
    mocks.endIfCancelled.mockResolvedValue(true);

    expect(await moves.endIfEnding(INTERRUPTED)).toBe(true);
    expect(mocks.isUnwinding).not.toHaveBeenCalled();
  });

  it("neither a cancel nor an undo: false, nothing taken", async () => {
    const { moves } = partsOf();

    expect(await moves.endIfEnding(INTERRUPTED)).toBe(false);
    expect(mocks.endUnwindingIfFree).not.toHaveBeenCalled();
  });

  it("an undo under way: its take decides", async () => {
    const { moves } = partsOf();
    mocks.isUnwinding.mockResolvedValue(true);
    mocks.endUnwindingIfFree.mockResolvedValue(true);

    expect(await moves.endIfEnding(INTERRUPTED)).toBe(true);
  });
});

describe("#901: a resume whose tree failed after its answer was recorded", () => {
  it.each(["failed", "guarded"])(
    "its root's record %s at the take: the lease given back, NotPausedError, no pass",
    async (status) => {
      const { moves, paused, lease, terns } = partsOf();
      terns.findByTenantIdAndRunId.mockResolvedValue({ threadId: "thread-1", status });
      mocks.treeResumeNow.mockResolvedValue(resumeOf("pause-1"));
      paused.find.mockResolvedValue({ run: { runId: ROOT } } as never);

      await expect(moves.resumed(answerOf("1.0.0"), call)).rejects.toBeInstanceOf(NotPausedError);
      expect(lease.released()).toBe(1);
      expect(mocks.observedPass).not.toHaveBeenCalled();
      expect(mocks.treeResumeNow).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["running on its thread", { threadId: "thread-1", status: "running" }],
    ["failed on another thread", { threadId: "thread-2", status: "failed" }],
  ])("a record %s: the pass runs", async (_case, record) => {
    const { moves, paused, terns } = partsOf();
    terns.findByTenantIdAndRunId.mockResolvedValue(record);
    mocks.treeResumeNow.mockResolvedValueOnce(resumeOf("pause-1"));
    paused.find.mockResolvedValue({ run: { runId: ROOT } } as never);
    mocks.observedPass.mockResolvedValue(output(ExecutionStatus.Finished));

    await moves.resumed(answerOf("1.0.0"), call);

    expect(mocks.observedPass).toHaveBeenCalledOnce();
  });
});

describe("#633: the drain", () => {
  it("a resume with nothing recorded for this run's pauses: the lease given back, the current output", async () => {
    for (const stored of [undefined, { run: { runId: "another-run" } }]) {
      const { moves, paused, lease } = partsOf();
      mocks.treeResumeNow.mockResolvedValue(resumeOf("pause-1"));
      paused.find.mockResolvedValue(stored as never);

      expect(await moves.resumed(answerOf("1.0.0"), call)).toMatchObject({
        status: ExecutionStatus.Paused,
      });
      expect(lease.released()).toBe(1);
      expect(mocks.observedPass).not.toHaveBeenCalled();
    }
  });

  it("each pass's answers taken once; the next pass never takes the pauses an earlier one did", async () => {
    const { moves, paused } = partsOf();
    const [first, second] = [resumeOf("pause-1", "pause-2"), resumeOf("pause-3")];
    const answers = [first, second];
    // the set the drain hands each look, as it held it then (the drain adds to one set)
    const passed: (readonly string[] | undefined)[] = [];
    mocks.treeResumeNow.mockImplementation(
      (_deps: unknown, _tree: unknown, seen?: ReadonlySet<string>) => {
        passed.push(seen === undefined ? undefined : [...seen]);
        return Promise.resolve(answers.shift());
      },
    );
    paused.find.mockResolvedValue({ run: { runId: ROOT } } as never);
    mocks.observedPass.mockResolvedValue(output(ExecutionStatus.Paused));

    await moves.resumed(answerOf("1.0.0"), call);

    expect(mocks.markTaken.mock.calls.map((args: unknown[]) => args[1])).toEqual([first, second]);
    expect(passed).toEqual([undefined, ["pause-1", "pause-2"], ["pause-1", "pause-2", "pause-3"]]);
    expect(mocks.forgetTree).not.toHaveBeenCalled();
  });

  it("a resume whose answers cannot be read: the lease given back, the error thrown", async () => {
    const { moves, lease } = partsOf();
    mocks.treeResumeNow.mockRejectedValue(new Error("checkpoint unreadable"));

    await expect(moves.resumed(answerOf("1.0.0"), call)).rejects.toThrow("checkpoint unreadable");
    expect(lease.released()).toBe(1);
  });

  it("a finished pass: no answers looked for, the tree forgotten, the lease released", async () => {
    const { moves, lease } = partsOf();

    await moves.recovered(INTERRUPTED, call);

    expect(mocks.treeResumeNow).not.toHaveBeenCalled();
    expect(mocks.forgetTree).toHaveBeenCalledOnce();
    expect(lease.released()).toBe(1);
  });
});
