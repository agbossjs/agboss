/**
 * #1356 (cancel shard) — a cancel request on its own (#360, #909, #1073, #1152): where it is read, what
 * the holder's watch does with it, how a tree that has one is ended — at a take, at rest, by the
 * sweep, from another instance — and what each of those hands the end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANCEL_REQUEST_KEY,
  cancelWatchOf,
  endCancelled,
  endedAtTake,
  endIfCancelled,
  endIfCancelledAtRest,
  isCancelRequested,
  isEndedAtTakeover,
  watchedBy,
  writeCancelRequest,
} from "../../src/app/cancel-requests.js";
import { remoteCancel } from "../../src/app/cancel-remote.js";
import { WITHOUT_RECOVERY_KEY } from "../../src/app/tree-ends.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { CompensationFailedError } from "../../src/flow/compensation.js";
import { LeaseTakeoverReason } from "../../src/infrastructure/execution-audit-log.repository.js";

const ended = vi.hoisted(() => ({ end: vi.fn() }));
vi.mock("../../src/app/ended-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/app/ended-tree.js")>()),
  endedWithoutPass: (...args: unknown[]) => ended.end(...args) as unknown,
}));

beforeEach(() => {
  ended.end.mockReset();
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

const TREE = { tenantId: "acme", rootExecutionId: "root-1" };
const STATE = { runId: "root-1", threadId: "thread-1", tenantId: "acme", startedVersion: "1" };

/** An execution tree store that holds the `keys` of the tree. */
const treesHolding = (keys: readonly string[], failing: readonly string[] = []) => ({
  findByIdInTree: vi.fn((_tree: unknown, key: string) => {
    if (failing.includes(key)) return Promise.reject(new Error("store down"));
    return Promise.resolve(keys.includes(key) ? { key } : undefined);
  }),
  saveIfAbsentInTree: vi.fn(() => Promise.resolve(true)),
  deleteAllInTree: vi.fn(() => Promise.resolve()),
});

const leaseOf = () => ({
  signal: new AbortController().signal,
  release: vi.fn(() => Promise.resolve()),
  afterEachRenewal: vi.fn(),
  whenCancelFound: vi.fn(),
});

/** What the cancel functions read of their workflow's app. */
function partsOf(
  options: {
    keys?: readonly string[];
    marked?: boolean;
    record?: { status: string; threadId: string } | undefined;
    holds?: boolean;
  } = {},
) {
  const trees = treesHolding(options.keys ?? []);
  const lease = leaseOf();
  const leases = {
    requestCancel: vi.fn(() => Promise.resolve()),
    isCancelRequested: vi.fn(() => Promise.resolve(options.marked ?? false)),
    hold: vi.fn((_tree: unknown, _held: unknown, _take: TakeSeen) => Promise.resolve(lease)),
    tryHold: vi.fn((_tree: unknown, _take: TakeSeen) =>
      Promise.resolve(options.holds === false ? undefined : lease),
    ),
  };
  const turns = {
    findByTenantIdAndRunId: vi.fn(() => Promise.resolve(options.record)),
    lastTurns: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
    byIds: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  };
  const clock = { now: () => new Date("2026-11-20T10:00:00.000Z") };
  const deps = { turns, config: { name: "bundle-a", version: "7" } };
  const parts = { deps, trees, leases, clock, paused: {} } as never;
  return { parts, trees, leases, turns, lease, deps };
}

describe("#1356: where a cancel request is read", () => {
  it("is the key of the tree, and a store error reads as none", async () => {
    expect(await isCancelRequested(treesHolding([CANCEL_REQUEST_KEY]) as never, TREE)).toBe(true);
    expect(await isCancelRequested(treesHolding([]) as never, TREE)).toBe(false);
    expect(await isCancelRequested(treesHolding([], [CANCEL_REQUEST_KEY]) as never, TREE)).toBe(
      false,
    );
  });

  it("a tree ends at a take for a request, or for a run no recovery continues, once each is asked", async () => {
    const withBoth = treesHolding([CANCEL_REQUEST_KEY, WITHOUT_RECOVERY_KEY]);

    expect(await isEndedAtTakeover(withBoth as never, TREE)).toBe(true);
    expect(withBoth.findByIdInTree).toHaveBeenCalledTimes(1);
    expect(await isEndedAtTakeover(treesHolding([WITHOUT_RECOVERY_KEY]) as never, TREE)).toBe(true);
    expect(await isEndedAtTakeover(treesHolding([]) as never, TREE)).toBe(false);
  });

  it("a store error reads as neither", async () => {
    expect(
      await isEndedAtTakeover(
        treesHolding([WITHOUT_RECOVERY_KEY], [CANCEL_REQUEST_KEY]) as never,
        TREE,
      ),
    ).toBe(true);
    expect(
      await isEndedAtTakeover(
        treesHolding([], [CANCEL_REQUEST_KEY, WITHOUT_RECOVERY_KEY]) as never,
        TREE,
      ),
    ).toBe(false);
  });
});

describe("#1356: writing a request", () => {
  it("marks the lease first, then writes the tree key, the request as given", async () => {
    const { parts, leases, trees } = partsOf();
    const order: string[] = [];
    leases.requestCancel.mockImplementation(() => {
      order.push("mark");
      return Promise.resolve();
    });
    trees.saveIfAbsentInTree.mockImplementation(() => {
      order.push("key");
      return Promise.resolve(true);
    });
    const request = { requestedAt: "2026-11-20T10:00:00.000Z", ownerId: null };

    await writeCancelRequest(parts, TREE, request);

    expect(order).toEqual(["mark", "key"]);
    expect(leases.requestCancel).toHaveBeenCalledWith(TREE, undefined);
    expect(trees.saveIfAbsentInTree).toHaveBeenCalledWith(TREE, CANCEL_REQUEST_KEY, request);
  });
});

describe("#1356: the holder's watch", () => {
  it("starts live, and a check that finds the request aborts it with the thread's cancel", async () => {
    const watch = cancelWatchOf(treesHolding([CANCEL_REQUEST_KEY]) as never, STATE);

    expect(watch.signal.aborted).toBe(false);
    expect(await watch.isRequested()).toBe(true);
    await watch.check();

    expect(watch.signal.aborted).toBe(true);
    expect(watch.signal.reason).toBeInstanceOf(ExecutionCancelledError);
    expect(watch.signal.reason).toHaveProperty("message", 'thread "thread-1" was cancelled');
  });

  it("a check that finds none aborts nothing, and one after the abort asks nothing more", async () => {
    const none = cancelWatchOf(treesHolding([]) as never, STATE);
    await none.check();
    expect(none.signal.aborted).toBe(false);
    expect(await none.isRequested()).toBe(false);

    const trees = treesHolding([CANCEL_REQUEST_KEY]);
    const watch = cancelWatchOf(trees as never, STATE);
    await watch.check();
    await watch.check();
    expect(trees.findByIdInTree).toHaveBeenCalledTimes(1);
  });

  it("is aborted at once by a write the cancel refused, with the thread's cancel as its reason", () => {
    const watch = cancelWatchOf(treesHolding([]) as never, STATE);

    watch.abortNow();
    watch.abortNow();

    expect(watch.signal.aborted).toBe(true);
    expect(watch.signal.reason).toBeInstanceOf(ExecutionCancelledError);
    expect(watch.signal.reason).toHaveProperty("message", 'thread "thread-1" was cancelled');
  });

  it("is started on a lease: its check after every renewal, its abort when a refusal is told", () => {
    const lease = leaseOf();
    const watch = cancelWatchOf(treesHolding([]) as never, STATE);

    watchedBy(lease as never, watch);

    expect(lease.afterEachRenewal).toHaveBeenCalledWith(watch.check);
    expect(lease.whenCancelFound).toHaveBeenCalledWith(watch.abortNow);
  });
});

describe("#1356: a cancelled tree's end", () => {
  it("is asked of the tree's end with the thread's cancel, the lease's signal, and its undo when there is one", async () => {
    const { parts, lease } = partsOf();
    const error = new Error("ended");
    ended.end.mockResolvedValue({ error, isEnded: true });
    const undo = { compensations: [] };

    expect(await endCancelled(parts, STATE, lease as never)).toBe(error);
    expect(await endCancelled(parts, STATE, lease as never, undo)).toBe(error);

    const [first, second] = ended.end.mock.calls as [unknown, unknown, Record<string, unknown>][];
    expect(first?.[2]).toStrictEqual({
      cause: expect.objectContaining({ message: 'thread "thread-1" was cancelled' }),
      signal: lease.signal,
      lease,
    });
    expect(first?.[1]).toBe(STATE);
    expect(second?.[2]).toStrictEqual({
      cause: expect.any(ExecutionCancelledError),
      signal: lease.signal,
      lease,
      undo,
    });
  });

  it("a lease just taken ends a tree with a request and is released after it, whatever came of the end", async () => {
    const { parts, lease } = partsOf({ keys: [CANCEL_REQUEST_KEY] });
    const error = new Error("ended");
    ended.end.mockResolvedValueOnce({ error, isEnded: true });

    expect(await endedAtTake(parts, STATE, lease as never)).toBe(error);
    expect(lease.release).toHaveBeenCalledTimes(1);

    const failing = partsOf({ keys: [CANCEL_REQUEST_KEY] });
    ended.end.mockRejectedValueOnce(new Error("undo failed"));
    await expect(endedAtTake(failing.parts, STATE, failing.lease as never)).rejects.toThrow(
      "undo failed",
    );
    expect(failing.lease.release).toHaveBeenCalledTimes(1);
  });

  it("a mark on a tree whose root is alive ends it too; on one that is over, or none, it does not", async () => {
    for (const [record, isEnded] of [
      [{ status: "running", threadId: "thread-1" }, true],
      [{ status: "paused", threadId: "thread-1" }, true],
      [{ status: "finished", threadId: "thread-1" }, false],
      [{ status: "running", threadId: "another-thread" }, false],
      [undefined, false],
    ] as const) {
      const { parts, lease } = partsOf({ marked: true, record });
      ended.end.mockResolvedValueOnce({ error: new Error("ended"), isEnded: true });

      const result = await endedAtTake(parts, STATE, lease as never);

      expect(result !== undefined).toBe(isEnded);
      expect(lease.release).toHaveBeenCalledTimes(isEnded ? 1 : 0);
    }
  });

  it("neither a request nor a mark leaves the tree and the lease as they are", async () => {
    const { parts, lease } = partsOf();

    expect(await endedAtTake(parts, STATE, lease as never)).toBeUndefined();
    expect(lease.release).not.toHaveBeenCalled();
  });
});

describe("#1356: a tree about to rest", () => {
  const result = (status: ExecutionStatus) => ({ status }) as never;

  it("with a request it is ended, and the moving call rejects with what ended it", async () => {
    const { parts, lease } = partsOf();
    const error = new Error("ended");
    ended.end.mockResolvedValueOnce({ error, isEnded: true });
    const undo = { compensations: [] };
    const watch = { isRequested: vi.fn(() => Promise.resolve(true)) } as never;

    await expect(
      endIfCancelledAtRest(parts, STATE, {
        result: result(ExecutionStatus.Paused),
        watch,
        lease: lease as never,
        undo,
      }),
    ).rejects.toBe(error);
    expect(ended.end.mock.calls.at(-1)?.[2]).toMatchObject({ undo });
  });

  it("without one, or when it did not pause, nothing is ended and the request is not even read", async () => {
    const { parts, lease } = partsOf();
    const isRequested = vi.fn(() => Promise.resolve(true));
    const watch = { isRequested } as never;
    const before = ended.end.mock.calls.length;

    await endIfCancelledAtRest(parts, STATE, {
      result: result(ExecutionStatus.Finished),
      watch,
      lease: lease as never,
      undo: { compensations: [] },
    });
    await endIfCancelledAtRest(parts, STATE, {
      result: result(ExecutionStatus.Paused),
      watch: { isRequested: () => Promise.resolve(false) } as never,
      lease: lease as never,
      undo: { compensations: [] },
    });

    expect(isRequested).not.toHaveBeenCalled();
    expect(ended.end.mock.calls).toHaveLength(before);
  });
});

describe("#1356: the sweep of a root with a request", () => {
  const swept = { ...STATE, turnId: "turn-1" };

  it("ends it under a lease taken only when free, as a takeover that is over once its record ended", async () => {
    const { parts, leases, lease, turns } = partsOf({ keys: [CANCEL_REQUEST_KEY] });
    ended.end.mockResolvedValueOnce({ error: new Error("ended"), isEnded: true });
    turns.byIds.mockResolvedValue([{ status: "failed" }]);

    expect(await endIfCancelled(parts, swept)).toBe(true);

    expect(leases.hold).not.toHaveBeenCalled();
    const [tree, take] = firstOf(leases.tryHold.mock.calls);
    expect(tree).toStrictEqual(TREE);
    expect(take).toMatchObject({ reason: LeaseTakeoverReason.Cancelled, isTakeover: true });
    expect(await take.isOver()).toBe(true);
    expect(turns.byIds).toHaveBeenCalledWith(["turn-1"]);
    turns.byIds.mockResolvedValue([{ status: "running" }]);
    expect(await take.isOver()).toBe(false);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("it had a request even when its lease was not free: a holder ends it", async () => {
    const { parts } = partsOf({ keys: [CANCEL_REQUEST_KEY], holds: false });

    expect(await endIfCancelled(parts, swept)).toBe(true);
  });

  it("with none, nothing is taken", async () => {
    const { parts, leases } = partsOf();

    expect(await endIfCancelled(parts, swept)).toBe(false);
    expect(leases.tryHold).not.toHaveBeenCalled();
    expect(leases.hold).not.toHaveBeenCalled();
  });
});

describe("#1356: a cancel of a thread that runs on another instance", () => {
  const turn = (fields: Record<string, unknown>) => ({
    id: "turn-1",
    runId: "root-1",
    threadId: "thread-1",
    tenantId: "acme",
    workflow: "bundle-a",
    status: "running",
    configVersion: "3",
    ...fields,
  });
  const thread = { tenantId: "acme", threadId: "thread-1" };

  it("writes a request for each running root of this application that has an id, as made now, by its owner", async () => {
    const { parts, turns, leases, trees } = partsOf();
    turns.lastTurns.mockResolvedValue([
      turn({ id: "t1", runId: "root-1" }),
      turn({ id: "t2", runId: "root-2", status: "failed" }),
      turn({ id: "t3", runId: "root-3", workflow: "bundle-b" }),
      turn({ id: "t4", runId: null }),
    ]);
    turns.byIds.mockResolvedValue([turn({ id: "t1" })]);

    expect(await remoteCancel(parts, thread, "owner-1")).toBe(true);

    expect(turns.lastTurns).toHaveBeenCalledWith("acme", "thread-1", 20);
    expect(leases.requestCancel.mock.calls).toEqual([
      [
        { tenantId: "acme", rootExecutionId: "root-1" },
        expect.objectContaining({ toStatus: "cancelling", trigger: "cancel" }),
      ],
    ]);
    expect(trees.saveIfAbsentInTree).toHaveBeenCalledWith(
      { tenantId: "acme", rootExecutionId: "root-1" },
      CANCEL_REQUEST_KEY,
      { requestedAt: "2026-11-20T10:00:00.000Z", ownerId: "owner-1" },
    );
    expect(turns.byIds).toHaveBeenCalledWith(["t1", "t4"]);
  });

  it("an owner that is none is written as null; with no running root nothing is written or read", async () => {
    const { parts, turns, trees } = partsOf();
    turns.lastTurns.mockResolvedValue([turn({})]);
    turns.byIds.mockResolvedValue([]);

    expect(await remoteCancel(parts, thread, undefined)).toBe(false);
    expect(trees.saveIfAbsentInTree).toHaveBeenCalledWith(expect.anything(), CANCEL_REQUEST_KEY, {
      requestedAt: "2026-11-20T10:00:00.000Z",
      ownerId: null,
    });

    const quiet = partsOf();
    quiet.turns.lastTurns.mockResolvedValue([turn({ status: "finished" })]);
    expect(await remoteCancel(quiet.parts, thread, undefined)).toBe(false);
    expect(quiet.turns.byIds).not.toHaveBeenCalled();
    expect(quiet.trees.saveIfAbsentInTree).not.toHaveBeenCalled();
  });

  it("a root still running after the request counts as cancelled: its holder stops within a renewal", async () => {
    const { parts, turns, leases } = partsOf();
    turns.lastTurns.mockResolvedValue([turn({})]);
    turns.byIds.mockResolvedValue([turn({})]);

    expect(await remoteCancel(parts, thread, undefined)).toBe(true);
    expect(leases.hold).not.toHaveBeenCalled();
  });

  it("a root that rests meanwhile is ended here, waiting for its lease, as its record's version", async () => {
    const { parts, turns, leases, lease } = partsOf();
    turns.lastTurns.mockResolvedValue([turn({})]);
    turns.byIds.mockResolvedValue([turn({ status: "paused" })]);
    ended.end.mockResolvedValueOnce({ error: new Error("ended"), isEnded: true });

    expect(await remoteCancel(parts, thread, undefined)).toBe(true);

    expect(leases.tryHold).not.toHaveBeenCalled();
    const [tree, noTake, take] = firstOf(leases.hold.mock.calls);
    expect(tree).toStrictEqual({ tenantId: "acme", rootExecutionId: "root-1" });
    expect(noTake).toBeUndefined();
    expect(take).toStrictEqual({ reason: LeaseTakeoverReason.Cancelled, isTakeover: false });
    expect(ended.end.mock.calls.at(-1)?.[1]).toStrictEqual({
      runId: "root-1",
      threadId: "thread-1",
      tenantId: "acme",
      startedVersion: "3",
    });
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("a record with no config version is read as the application's", async () => {
    const { parts, turns } = partsOf();
    turns.lastTurns.mockResolvedValue([turn({})]);
    turns.byIds.mockResolvedValue([turn({ status: "paused", configVersion: undefined })]);
    ended.end.mockResolvedValueOnce({ error: new Error("ended"), isEnded: true });

    await remoteCancel(parts, thread, undefined);

    expect(ended.end.mock.calls.at(-1)?.[1]).toMatchObject({ startedVersion: "7" });
  });

  it("a root that rests but whose lease is not free is not cancelled here; an undo that failed rejects", async () => {
    const busy = partsOf({ holds: true });
    busy.turns.lastTurns.mockResolvedValue([turn({})]);
    busy.turns.byIds.mockResolvedValue([turn({ status: "paused" })]);
    busy.leases.hold.mockResolvedValue(undefined as never);
    expect(await remoteCancel(busy.parts, thread, undefined)).toBe(false);

    const failing = partsOf();
    failing.turns.lastTurns.mockResolvedValue([turn({})]);
    failing.turns.byIds.mockResolvedValue([turn({ status: "paused" })]);
    const failure = new CompensationFailedError({ failures: [] });
    ended.end.mockResolvedValueOnce({ error: failure, isEnded: true });
    await expect(remoteCancel(failing.parts, thread, undefined)).rejects.toBe(failure);
  });

  it("a root that ended between the request and now is not cancelled; its keys go with the request", async () => {
    const { parts, turns, trees } = partsOf();
    turns.lastTurns.mockResolvedValue([turn({})]);
    turns.byIds.mockResolvedValue([turn({ status: "finished" })]);

    expect(await remoteCancel(parts, thread, undefined)).toBe(false);
    expect(trees.deleteAllInTree).toHaveBeenCalledWith({
      tenantId: "acme",
      rootExecutionId: "root-1",
    });
  });

  it("a root with no id (its record not written yet) is not found", async () => {
    const { parts, turns, trees } = partsOf();
    turns.lastTurns.mockResolvedValue([turn({ runId: null })]);
    turns.byIds.mockResolvedValue([turn({ runId: null })]);

    expect(await remoteCancel(parts, thread, undefined)).toBe(false);
    expect(trees.saveIfAbsentInTree).not.toHaveBeenCalled();
    expect(trees.deleteAllInTree).not.toHaveBeenCalled();
  });
});
