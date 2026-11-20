/**
 * #1356 (cancel shard) — the cancel of a thread and of a tree at rest on their own: the durable mark,
 * a paused tree's cancel under its lease and what became of a request that a holder moved on, the sweep of a
 * resting tree whose cancel died half way, and the checks `app.cancel` makes first.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelledPaused } from "../../src/app/cancel-paused.js";
import { isCancelMarked, isMarkedAlive } from "../../src/app/cancel-marks.js";
import { CANCEL_REQUEST_KEY } from "../../src/app/cancel-requests.js";
import { endRestingCancelled, RESTING } from "../../src/app/cancel-resting.js";
import { cancelThread } from "../../src/app/cancel-thread.js";
import {
  ExecutionCancelledError,
  InvalidThreadIdError,
  KeyTextRule,
} from "../../src/core/errors.js";
import { ExecutionOperation } from "../../src/core/observability.js";
import { CompensationFailedError } from "../../src/flow/compensation.js";
import { LeaseTakeoverReason } from "../../src/infrastructure/execution-audit-log.repository.js";

const ended = vi.hoisted(() => ({ end: vi.fn() }));
vi.mock("../../src/app/ended-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/ended-tree.js")>()),
  endedWithoutPass: (...args: unknown[]) => ended.end(...args) as unknown,
}));

beforeEach(() => {
  ended.end.mockReset();
  ended.end.mockResolvedValue({ error: new Error("ended"), isEnded: true });
});

/** The take a lease is asked for, as the cancel functions build it. */
interface TakeSeen {
  readonly reason: string;
  readonly isTakeover: boolean;
  readonly isOver: () => Promise<boolean>;
  readonly checkpointIdOf: () => Promise<string | undefined>;
}

/** The first call of a mock. */
const firstOf = <T>(calls: readonly T[]): T => {
  const [first] = calls;
  if (first === undefined) throw new Error("never called");
  return first;
};

const TREE = { tenantId: "acme", rootExecutionId: "run-1" };
const STATE = { runId: "run-1", threadId: "thread-1", tenantId: "acme", startedVersion: "5" };
const THREAD = { tenantId: "acme", threadId: "thread-1" };

const leaseOf = () => ({
  signal: new AbortController().signal,
  release: vi.fn(() => Promise.resolve()),
});

/** What the cancel functions read of their workflow's app. */
function partsOf(
  options: {
    marked?: boolean | Error;
    record?: unknown;
    recordFails?: boolean;
    found?: unknown[];
    pausePresent?: boolean;
    holds?: boolean;
  } = {},
) {
  const lease = leaseOf();
  const leases = {
    requestCancel: vi.fn(() => Promise.resolve()),
    isCancelRequested: vi.fn(() =>
      options.marked instanceof Error
        ? Promise.reject(options.marked)
        : Promise.resolve(options.marked ?? false),
    ),
    hold: vi.fn((_tree: unknown, _held: unknown, _take: TakeSeen) => Promise.resolve(lease)),
    tryHold: vi.fn((_tree: unknown, _take: TakeSeen) =>
      Promise.resolve(options.holds === false ? undefined : lease),
    ),
  };
  const trees = {
    saveIfAbsentInTree: vi.fn(() => Promise.resolve(true)),
    deleteAllInTree: vi.fn(() => Promise.resolve()),
    findByIdInTree: vi.fn(() => Promise.resolve(undefined)),
  };
  const turns = {
    findByTenantIdAndRunId: vi.fn(() =>
      options.recordFails === true
        ? Promise.reject(new Error("store down"))
        : Promise.resolve(options.record),
    ),
    byIds: vi.fn((): Promise<unknown[]> => Promise.resolve([{ status: RESTING }])),
    lastTurns: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  };
  const found = [...(options.found ?? [])];
  const paused = {
    find: vi.fn(() => Promise.resolve(found.shift())),
    drop: vi.fn(() => Promise.resolve()),
  };
  const deps = {
    turns,
    config: { name: "bundle-a", version: "7" },
    ...(options.pausePresent === true
      ? {
          pause: {
            checkpointer: { getTuple: vi.fn(() => Promise.resolve({ checkpoint: { id: "c-1" } })) },
          },
        }
      : {}),
  };
  const clock = { now: () => new Date("2026-11-20T10:00:00.000Z") };
  const parts = { deps, trees, leases, clock, paused } as never;
  return { parts, trees, leases, turns, lease, paused, deps };
}

describe("#1356: the cancel mark of a tree's lease", () => {
  it("is the lease row's, and a store error reads as none", async () => {
    expect(await isCancelMarked(partsOf({ marked: true }).leases as never, TREE)).toBe(true);
    expect(await isCancelMarked(partsOf({ marked: false }).leases as never, TREE)).toBe(false);
    expect(await isCancelMarked(partsOf({ marked: new Error("down") }).leases as never, TREE)).toBe(
      false,
    );
  });

  it("counts for a tree whose root is alive — running or resting — and for no other", async () => {
    const alive = (status: string, threadId = "thread-1") => ({ status, threadId });

    expect(
      await isMarkedAlive(partsOf({ marked: true, record: alive("running") }).parts, STATE),
    ).toBe(true);
    expect(
      await isMarkedAlive(partsOf({ marked: true, record: alive("paused") }).parts, STATE),
    ).toBe(true);
    expect(
      await isMarkedAlive(partsOf({ marked: true, record: alive("failed") }).parts, STATE),
    ).toBe(false);
    expect(await isMarkedAlive(partsOf({ marked: true, record: undefined }).parts, STATE)).toBe(
      false,
    );
    expect(
      await isMarkedAlive(partsOf({ marked: false, record: alive("running") }).parts, STATE),
    ).toBe(false);
  });

  it("a root whose record cannot be read is not alive for it", async () => {
    expect(await isMarkedAlive(partsOf({ marked: true, recordFails: true }).parts, STATE)).toBe(
      false,
    );
  });
});

describe("#1356: a resting tree whose cancel died half way", () => {
  const swept = { ...STATE, turnId: "turn-1" };

  it("with no mark nothing is taken", async () => {
    const { parts, leases } = partsOf({ marked: false });

    expect(await endRestingCancelled(parts, swept)).toBe(false);
    expect(leases.tryHold).not.toHaveBeenCalled();
  });

  it("with a mark it is ended as `app.cancel` ends it, under the lease taken only when free, released after", async () => {
    const { parts, leases, lease } = partsOf({ marked: true });

    expect(await endRestingCancelled(parts, swept)).toBe(true);

    expect(leases.hold).not.toHaveBeenCalled();
    const [tree, take] = firstOf(leases.tryHold.mock.calls);
    expect(tree).toStrictEqual(TREE);
    expect(take).toMatchObject({ reason: LeaseTakeoverReason.Cancelled, isTakeover: false });
    expect(ended.end.mock.calls[0]?.[1]).toBe(swept);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("a lease held elsewhere is a later look: false, nothing ended", async () => {
    const { parts } = partsOf({ marked: true, holds: false });

    expect(await endRestingCancelled(parts, swept)).toBe(false);
    expect(ended.end).not.toHaveBeenCalled();
  });

  it("the lease is released when the end fails", async () => {
    const { parts, lease } = partsOf({ marked: true });
    ended.end.mockRejectedValue(new Error("undo failed"));

    await expect(endRestingCancelled(parts, swept)).rejects.toThrow("undo failed");
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("the take is over once the root's record no longer rests: moved, ended, or gone", async () => {
    const { parts, leases, turns } = partsOf({ marked: true });
    await endRestingCancelled(parts, swept);
    const [, take] = firstOf(leases.tryHold.mock.calls);

    turns.byIds.mockResolvedValue([{ status: RESTING }]);
    expect(await take.isOver()).toBe(false);
    turns.byIds.mockResolvedValue([{ status: "running" }]);
    expect(await take.isOver()).toBe(true);
    turns.byIds.mockResolvedValue([{ status: "failed" }]);
    expect(await take.isOver()).toBe(true);
    turns.byIds.mockResolvedValue([]);
    expect(await take.isOver()).toBe(true);
    expect(turns.byIds).toHaveBeenLastCalledWith(["turn-1"]);
  });

  it("reads the head checkpoint of the root's own thread when the application keeps pauses", async () => {
    const { parts, leases, deps } = partsOf({ marked: true, pausePresent: true });
    await endRestingCancelled(parts, swept);
    const [, take] = firstOf(leases.tryHold.mock.calls);

    expect(await take.checkpointIdOf()).toBe("c-1");
    expect(deps.pause?.checkpointer.getTuple).toHaveBeenCalledWith({
      configurable: { thread_id: "run-1" },
    });
  });
});

const pausedRun = (runId = "run-1", startedVersion: string | null = "5") => ({
  run: { runId, ...(startedVersion === null ? {} : { startedVersion }) },
});

describe("#1356: the cancel of a thread resting paused", () => {
  it("is false when the thread rests paused no more, with nothing written", async () => {
    const { parts, leases } = partsOf({ found: [undefined] });

    expect(await cancelledPaused(parts, THREAD)).toBe(false);
    expect(leases.requestCancel).not.toHaveBeenCalled();
  });

  it("writes the request first, then ends the run under the tree's lease with the cancel's reason, and releases", async () => {
    const { parts, leases, trees, lease } = partsOf({ found: [pausedRun(), pausedRun()] });

    expect(await cancelledPaused(parts, THREAD)).toBe(true);

    expect(leases.requestCancel).toHaveBeenCalledWith(TREE);
    expect(trees.saveIfAbsentInTree).toHaveBeenCalledWith(TREE, CANCEL_REQUEST_KEY, {
      requestedAt: "2026-11-20T10:00:00.000Z",
      ownerId: null,
    });
    const [heldTree, noTake, take] = firstOf(leases.hold.mock.calls);
    expect(heldTree).toStrictEqual(TREE);
    expect(noTake).toBeUndefined();
    expect(take).toStrictEqual({ reason: LeaseTakeoverReason.Cancelled, isTakeover: false });
    const [, state, end] = ended.end.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(state).toStrictEqual({ ...THREAD, runId: "run-1", startedVersion: "5" });
    expect(end.cause).toBeInstanceOf(ExecutionCancelledError);
    expect(end.cause).toHaveProperty("message", 'thread "thread-1" was cancelled while paused');
    expect(end.signal).toBe(lease.signal);
    expect(end.lease).toBe(lease);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("a run with no version of its own is ended as the application's", async () => {
    const { parts } = partsOf({
      found: [pausedRun("run-1", null), pausedRun("run-1", null)],
    });

    await cancelledPaused(parts, THREAD);

    expect(ended.end.mock.calls[0]?.[1]).toMatchObject({ startedVersion: "7" });
  });

  it("an undo that failed rejects the cancel with it, the lease still released", async () => {
    const { parts, lease } = partsOf({ found: [pausedRun(), pausedRun()] });
    const failure = new CompensationFailedError({ failures: [] });
    ended.end.mockResolvedValue({ error: failure, isEnded: true });

    await expect(cancelledPaused(parts, THREAD)).rejects.toBe(failure);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("a failing end releases the lease as well", async () => {
    const { parts, lease } = partsOf({ found: [pausedRun(), pausedRun()] });
    ended.end.mockRejectedValue(new Error("store down"));

    await expect(cancelledPaused(parts, THREAD)).rejects.toThrow("store down");
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("with a run id it cancels that run only, even while another run of the thread rests paused", async () => {
    const { parts, leases } = partsOf({ found: [pausedRun("run-9"), pausedRun("run-2")] });

    // the thread's paused run is run-2 by now: the one asked for was moved by its holder
    expect(await cancelledPaused(parts, THREAD, "run-1")).toBe(false);

    expect(leases.requestCancel).toHaveBeenCalledWith({
      tenantId: "acme",
      rootExecutionId: "run-1",
    });
    expect(ended.end).not.toHaveBeenCalled();
  });

  describe("a run a holder moved while the cancel waited for the lease", () => {
    const moved = (record: unknown) => {
      const made = partsOf({ found: [pausedRun(), undefined], record });
      return made;
    };

    it("ended as cancelled by its holder: the cancel did its job, and the keys of the tree are removed", async () => {
      const { parts, trees, turns } = moved({
        status: "failed",
        threadId: "thread-1",
        stopReason: 'thread "thread-1" was cancelled',
      });

      expect(await cancelledPaused(parts, THREAD)).toBe(true);
      expect(trees.deleteAllInTree).toHaveBeenCalledWith(TREE);
      expect(turns.findByTenantIdAndRunId).toHaveBeenCalledWith("acme", "run-1");
    });

    it("the stop reason the framework writes for a cancel counts as one", async () => {
      const { parts } = moved({
        status: "failed",
        threadId: "thread-1",
        stopReason: "the run was cancelled",
      });

      expect(await cancelledPaused(parts, THREAD)).toBe(true);
    });

    it("ended otherwise: the request is withdrawn with the tree's keys, and the cancel was too late", async () => {
      for (const record of [
        { status: "failed", threadId: "thread-1", stopReason: "a model failed" },
        { status: "finished", threadId: "thread-1", stopReason: 'thread "thread-1" was cancelled' },
      ]) {
        const { parts, trees } = moved(record);

        expect(await cancelledPaused(parts, THREAD)).toBe(false);
        expect(trees.deleteAllInTree).toHaveBeenCalledWith(TREE);
      }
    });

    it("moving still, or gone: nothing is removed, and the cancel is not done", async () => {
      for (const record of [
        { status: "running", threadId: "thread-1", stopReason: "" },
        { status: "paused", threadId: "thread-1", stopReason: "" },
        undefined,
      ]) {
        const { parts, trees } = moved(record);

        expect(await cancelledPaused(parts, THREAD)).toBe(false);
        expect(trees.deleteAllInTree).not.toHaveBeenCalled();
      }
    });
  });
});

describe("#1356: `app.cancel` of a thread", () => {
  const live = (running: boolean, trees: readonly unknown[] = []) => ({
    treesOf: vi.fn(() => trees),
    abort: vi.fn(() => running),
  });

  function thread(
    options: {
      running?: boolean;
      trees?: readonly unknown[];
      found?: unknown[];
      known?: () => Promise<void>;
    } = {},
  ) {
    const made = partsOf({ found: options.found ?? [] });
    const requests: unknown[] = [];
    const known = vi.fn(options.known ?? (() => Promise.resolve()));
    const parts = {
      ...(made.parts as object),
      live: live(options.running ?? false, options.trees),
      admit: vi.fn(async (request: unknown, checks: () => Promise<unknown>) => {
        requests.push(request);
        await checks();
      }),
      known,
    } as never;
    return { ...made, parts, requests, known };
  }

  it("is admitted as a cancel of the thread, its tenant defaulted, after the thread is checked as the caller's", async () => {
    const { parts, requests, known } = thread({ running: true });

    await cancelThread(parts, "thread-1", { ownerId: "owner-1" });

    expect(requests).toEqual([
      { operation: ExecutionOperation.Cancel, tenantId: "default", threadId: "thread-1" },
    ]);
    expect(known).toHaveBeenCalledWith({
      tenantId: "default",
      threadId: "thread-1",
      ownerId: "owner-1",
    });
  });

  it("refuses a tenant id, a thread id and an owner id that are no key's text, before anything is asked", async () => {
    const bad = (threadId: string, options: { tenantId?: string; ownerId?: string }) =>
      cancelThread(thread({ running: true }).parts, threadId, options);

    await expect(bad("thread-1", { tenantId: "" })).rejects.toThrow(/tenantId/);
    await expect(bad("", {})).rejects.toBeInstanceOf(InvalidThreadIdError);
    await expect(bad("", {})).rejects.toMatchObject({
      rule: KeyTextRule.Length,
      message: expect.stringContaining("Not a thread id (length)") as unknown,
    });
    await expect(bad("thread-1", { ownerId: "" })).rejects.toThrow(/CancelOptions[\s\S]*ownerId/);
  });

  it("a refused check asks nothing and cancels nothing", async () => {
    const { parts, paused } = thread({
      running: true,
      known: () => Promise.reject(new Error("not yours")),
    });

    await expect(cancelThread(parts, "thread-1", {})).rejects.toThrow("not yours");
    expect(paused.drop).not.toHaveBeenCalled();
  });

  it("marks every tree of the thread, then aborts the run here and drops its paused run", async () => {
    const trees = [TREE, { tenantId: "acme", rootExecutionId: "run-2" }];
    const { parts, leases, paused } = thread({ running: true, trees });

    expect(await cancelThread(parts, "thread-1", { tenantId: "acme" })).toEqual({
      cancelled: true,
    });

    expect(leases.requestCancel.mock.calls).toEqual([[trees[0]], [trees[1]]]);
    expect(paused.drop).toHaveBeenCalledWith(THREAD);
  });

  it("a run that does not run here but rests paused is cancelled as paused", async () => {
    const { parts, leases } = thread({ found: [pausedRun(), pausedRun()] });

    expect(await cancelThread(parts, "thread-1", { tenantId: "acme" })).toEqual({
      cancelled: true,
    });
    expect(leases.requestCancel).toHaveBeenCalledWith(TREE);
  });

  it("else its execution on another instance gets a request, as its owner's", async () => {
    const { parts, turns, trees } = thread({});
    turns.lastTurns.mockResolvedValue([
      {
        id: "t1",
        runId: "run-1",
        threadId: "thread-1",
        tenantId: "acme",
        bundle: "bundle-a",
        status: "running",
      },
    ]);
    turns.byIds.mockResolvedValue([{ id: "t1", runId: "run-1", status: "running" }]);

    expect(await cancelThread(parts, "thread-1", { tenantId: "acme", ownerId: "owner-1" })).toEqual(
      {
        cancelled: true,
      },
    );
    expect(trees.saveIfAbsentInTree).toHaveBeenCalledWith(TREE, CANCEL_REQUEST_KEY, {
      requestedAt: "2026-11-20T10:00:00.000Z",
      ownerId: "owner-1",
    });
  });
});
