import { usd } from "../../src/units/index.js";
/**
 * #1366 (shard `cancel-x-runs`) on its own: the runs in flight a cancel aborts (`live-runs.ts`) — by thread
 * and by tree, each index emptied when its runs end —, what the stop of the instance does to them and to the
 * callers waiting for them, the Turn outcome of a cancelled run.
 */
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ApplicationStoppingError, ExecutionCancelledError } from "../../src/core/errors.js";
import {
  cancelledErrorOf,
  cancelledOutcome,
  cancelledRecordOutcome,
  CANCELLED_STOP_REASON,
} from "../../src/app/cancelled-run.js";
import { abortAll, counted, entered } from "../../src/app/live-run-index.js";
import { LiveRuns, runOptionsOf } from "../../src/app/live-runs.js";

const THREAD = { tenantId: "acme", threadId: "thread-1" };
const TREE = { tenantId: "acme", rootExecutionId: "root-1" };

/** A run that waits until `finish` is called, and the signal it was given. */
function pending<T = string>() {
  let finish: (value: T) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const done = new Promise<T>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const seen: { signal?: AbortSignal } = {};
  const work = (signal: AbortSignal): Promise<T> => {
    seen.signal = signal;
    return done;
  };
  return { work, finish, fail, seen };
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("#1366: the runs a cancel aborts", () => {
  it("track returns the run's value and passes the run's error on", async () => {
    const runs = new LiveRuns();

    expect(await runs.track(THREAD, undefined, () => Promise.resolve("done"))).toBe("done");
    await expect(
      runs.track(THREAD, undefined, () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");
  });

  it("a cancel of the thread aborts its run with the cancelled error and says so; once the run ended there is nothing to abort", async () => {
    const runs = new LiveRuns();
    const run = pending();
    const tracked = runs.track(THREAD, undefined, run.work);

    expect(run.seen.signal?.aborted).toBe(false);
    expect(runs.abort(THREAD)).toBe(true);

    expect(run.seen.signal?.aborted).toBe(true);
    expect(run.seen.signal?.reason).toBeInstanceOf(ExecutionCancelledError);
    expect((run.seen.signal?.reason as Error).message).toBe('thread "thread-1" was cancelled');
    run.finish("x");
    await tracked;
    expect(runs.abort(THREAD)).toBe(false);
  });

  it("nothing running: false", () => {
    expect(new LiveRuns().abort(THREAD)).toBe(false);
    expect(new LiveRuns().abortExecution(TREE, "thread-1")).toBe(false);
  });

  it("a thread of another tenant, or another thread, is not cancelled", async () => {
    const runs = new LiveRuns();
    const run = pending();
    const tracked = runs.track(THREAD, undefined, run.work);

    expect(runs.abort({ tenantId: "other", threadId: "thread-1" })).toBe(false);
    expect(runs.abort({ tenantId: "acme", threadId: "thread-2" })).toBe(false);
    expect(run.seen.signal?.aborted).toBe(false);
    run.finish("x");
    await tracked;
  });

  it("every run of a thread is aborted; one that ended leaves the others cancellable", async () => {
    const runs = new LiveRuns();
    const first = pending();
    const second = pending();
    const a = runs.track(THREAD, undefined, first.work);
    const b = runs.track(THREAD, undefined, second.work);

    first.finish("1");
    await a;
    expect(runs.abort(THREAD)).toBe(true);
    expect(second.seen.signal?.aborted).toBe(true);
    expect(first.seen.signal?.aborted).toBe(false);
    second.finish("2");
    await b;
    expect(runs.abort(THREAD)).toBe(false);
  });

  it("two runs of a thread are both aborted by one cancel", async () => {
    const runs = new LiveRuns();
    const first = pending();
    const second = pending();
    const a = runs.track(THREAD, undefined, first.work);
    const b = runs.track(THREAD, undefined, second.work);

    expect(runs.abort(THREAD)).toBe(true);

    expect(first.seen.signal?.aborted).toBe(true);
    expect(second.seen.signal?.aborted).toBe(true);
    first.finish("1");
    second.finish("2");
    await Promise.all([a, b]);
  });

  it("the caller's own signal aborts the run too, with the caller's reason; with none, only a cancel does", async () => {
    const runs = new LiveRuns();
    const caller = new AbortController();
    const run = pending();
    const tracked = runs.track(THREAD, caller.signal, run.work);

    caller.abort(new Error("the caller left"));

    expect(run.seen.signal?.aborted).toBe(true);
    expect((run.seen.signal?.reason as Error).message).toBe("the caller left");
    run.finish("x");
    await tracked;

    const alone = pending();
    const own = runs.track(THREAD, undefined, alone.work);
    expect(alone.seen.signal?.aborted).toBe(false);
    alone.finish("x");
    await own;
  });

  it("a leg that moves a tree is cancelled by its tree and thread, never by a tree of that id on another thread", async () => {
    const runs = new LiveRuns();
    const leg = pending();
    const sibling = pending();
    const a = runs.track({ ...THREAD, runId: "root-1" }, undefined, leg.work);
    const b = runs.track(
      { ...THREAD, threadId: "thread-2", runId: "root-1" },
      undefined,
      sibling.work,
    );

    expect(runs.abortExecution(TREE, "thread-1")).toBe(true);

    expect(leg.seen.signal?.aborted).toBe(true);
    expect(leg.seen.signal?.reason).toBeInstanceOf(ExecutionCancelledError);
    expect(sibling.seen.signal?.aborted).toBe(false);
    expect(runs.abortExecution({ ...TREE, tenantId: "other" }, "thread-2")).toBe(false);
    expect(runs.abortExecution({ ...TREE, rootExecutionId: "root-2" }, "thread-2")).toBe(false);
    leg.finish("1");
    sibling.finish("2");
    await Promise.all([a, b]);
    expect(runs.abortExecution(TREE, "thread-1")).toBe(false);
    expect(runs.abortExecution(TREE, "thread-2")).toBe(false);
  });

  it("a leg of a thread with no tree is no leg of a tree", async () => {
    const runs = new LiveRuns();
    const run = pending();
    const tracked = runs.track(THREAD, undefined, run.work);

    expect(runs.abortExecution(TREE, "thread-1")).toBe(false);
    expect(runs.treesOf(THREAD)).toEqual([]);
    run.finish("x");
    await tracked;
  });

  it("the trees a thread moves now: each root once, counted per leg, gone with its last leg", async () => {
    const runs = new LiveRuns();
    const first = pending();
    const second = pending();
    const other = pending();
    const a = runs.track({ ...THREAD, runId: "root-1" }, undefined, first.work);
    const b = runs.track({ ...THREAD, runId: "root-1" }, undefined, second.work);
    const c = runs.track({ ...THREAD, runId: "root-2" }, undefined, other.work);

    expect(runs.treesOf(THREAD)).toEqual([TREE, { tenantId: "acme", rootExecutionId: "root-2" }]);
    expect(runs.treesOf({ tenantId: "other", threadId: "thread-1" })).toEqual([]);
    expect(runs.treesOf({ tenantId: "acme", threadId: "thread-2" })).toEqual([]);

    first.finish("1");
    await a;
    expect(runs.treesOf(THREAD)).toEqual([TREE, { tenantId: "acme", rootExecutionId: "root-2" }]);
    second.finish("2");
    await b;
    expect(runs.treesOf(THREAD)).toEqual([{ tenantId: "acme", rootExecutionId: "root-2" }]);
    other.finish("3");
    await c;
    expect(runs.treesOf(THREAD)).toEqual([]);
  });
});

describe("#1366: the stop of the instance", () => {
  it("interrupt aborts the runs in flight with its reason, and the instance's interruption signal; later runs start aborted", async () => {
    const runs = new LiveRuns();
    const run = pending();
    const tracked = runs.track(THREAD, undefined, run.work);
    const reason = new Error("shutdown timeout");

    expect(runs.interruption.aborted).toBe(false);
    runs.interrupt(reason);

    expect(run.seen.signal?.reason).toBe(reason);
    expect(runs.interruption.aborted).toBe(true);
    expect(runs.interruption.reason).toBe(reason);
    run.finish("x");
    await tracked;

    const later = pending();
    const next = runs.track(THREAD, undefined, later.work);
    expect(later.seen.signal?.aborted).toBe(true);
    expect(later.seen.signal?.reason).toBe(reason);
    later.finish("y");
    await next;
  });

  it("a second interrupt changes no reason", async () => {
    const runs = new LiveRuns();
    const first = new Error("first");
    runs.interrupt(first);
    runs.interrupt(new Error("second"));

    expect(runs.interruption.reason).toBe(first);
    const run = pending();
    const tracked = runs.track(THREAD, undefined, run.work);
    expect(run.seen.signal?.reason).toBe(first);
    run.finish("x");
    await tracked;
  });

  it("runs of every thread are interrupted, not one", async () => {
    const runs = new LiveRuns();
    const first = pending();
    const second = pending();
    const a = runs.track(THREAD, undefined, first.work);
    const b = runs.track({ tenantId: "acme", threadId: "thread-2" }, undefined, second.work);

    runs.interrupt(new Error("stop"));

    expect(first.seen.signal?.aborted).toBe(true);
    expect(second.seen.signal?.aborted).toBe(true);
    first.finish("1");
    second.finish("2");
    await Promise.all([a, b]);
  });

  it("settled waits for the runs and moves in flight, those begun meanwhile too", async () => {
    const runs = new LiveRuns();
    const run = pending();
    const move = pending();
    const late = pending();
    const tracked = runs.track(THREAD, undefined, run.work);
    const moving = runs.moving(move.work(new AbortController().signal));
    let settled = false;
    const waiting = runs.settled().then(() => {
      settled = true;
    });

    run.finish("1");
    await tracked;
    await turn();
    expect(settled).toBe(false);
    const lateRun = runs.track(THREAD, undefined, late.work);
    move.finish("2");
    await moving;
    await turn();
    expect(settled).toBe(false);
    late.finish("3");
    await lateRun;
    await waiting;
    expect(settled).toBe(true);
  });

  it("a move that fails passes its error on and is no longer in flight", async () => {
    const runs = new LiveRuns();

    await expect(runs.moving(Promise.reject(new Error("move failed")))).rejects.toThrow(
      "move failed",
    );
    await runs.settled();
    expect(await runs.moving(Promise.resolve("moved"))).toBe("moved");
  });

  it("settledByStop with no stop under way is settled", async () => {
    const runs = new LiveRuns();
    const run = pending();
    const tracked = runs.track(THREAD, undefined, run.work);
    let done = false;
    const waiting = runs.settledByStop().then(() => {
      done = true;
    });

    await turn();
    expect(done).toBe(false);
    run.finish("x");
    await tracked;
    await waiting;
    expect(done).toBe(true);
  });

  it("settledByStop while stopping: the run that never ends is given up at the end of the shutdown timeout", async () => {
    const runs = new LiveRuns();
    const run = pending();
    void runs.track(THREAD, undefined, run.work);
    const deadline = new AbortController();
    runs.stopBy(deadline.signal);
    let done = false;
    const waiting = runs.settledByStop().then(() => {
      done = true;
    });

    await turn();
    expect(done).toBe(false);
    deadline.abort();
    await waiting;
    expect(done).toBe(true);
    run.finish("x");
  });

  it("the stop's deadline is listened to once by the stop and once by each wait for it: the listeners go with the abort", async () => {
    const runs = new LiveRuns();
    const run = pending();
    void runs.track(THREAD, undefined, run.work);
    const deadline = new AbortController();
    runs.stopBy(deadline.signal);
    expect(getEventListeners(deadline.signal, "abort")).toHaveLength(1);
    const waiting = runs.settledByStop();
    expect(getEventListeners(deadline.signal, "abort")).toHaveLength(2);

    deadline.abort();
    await waiting;

    expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
    run.finish("x");
  });

  it("a second interrupt aborts the instance's interruption no more", () => {
    const runs = new LiveRuns();
    const abort = vi.spyOn(AbortController.prototype, "abort");

    runs.interrupt(new Error("first"));
    runs.interrupt(new Error("second"));
    const calls = abort.mock.calls.length;
    abort.mockRestore();

    expect(calls).toBe(1);
  });

  it("settledByStop after the deadline passed: no waiting at all", async () => {
    const runs = new LiveRuns();
    const run = pending();
    void runs.track(THREAD, undefined, run.work);
    const deadline = new AbortController();
    deadline.abort();
    runs.stopBy(deadline.signal);

    const outcome = await Promise.race([
      runs.settledByStop().then(() => "settled"),
      new Promise((resolve) => setTimeout(resolve, 50, "waiting")),
    ]);

    expect(outcome).toBe("settled");
    run.finish("x");
  });

  it("settledByStop while stopping ends with the runs too, before the deadline", async () => {
    const runs = new LiveRuns();
    const run = pending();
    const tracked = runs.track(THREAD, undefined, run.work);
    runs.stopBy(new AbortController().signal);
    let done = false;
    const waiting = runs.settledByStop().then(() => {
      done = true;
    });

    await turn();
    expect(done).toBe(false);
    run.finish("x");
    await tracked;
    await waiting;
    expect(done).toBe(true);
  });

  it("the first deadline of a stop is the one; a second stopBy changes nothing", async () => {
    const runs = new LiveRuns();
    const first = new AbortController();
    const second = new AbortController();
    runs.stopBy(first.signal);
    runs.stopBy(second.signal);
    // every outcome of the waiting caller is collected: a second deadline would settle it early, a second time
    const outcomes: unknown[] = [];
    const waiting = runs
      .untilAbandoned(new Promise<never>(() => undefined))
      .catch((error: unknown) => {
        outcomes.push(error);
      });

    second.abort();
    await turn();
    await turn();
    expect(outcomes).toEqual([]);
    first.abort();
    await waiting;

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toBeInstanceOf(ApplicationStoppingError);
  });

  it("a caller waiting for a run is told the run is given up once the stop's end passes, and the run's late outcome is dropped", async () => {
    const runs = new LiveRuns();
    const deadline = new AbortController();
    runs.stopBy(deadline.signal);
    const run = pending();
    const waiting = runs.untilAbandoned(run.work(new AbortController().signal));
    const caught = waiting.catch((error: unknown) => error);

    deadline.abort();
    const error = await caught;

    expect(error).toBeInstanceOf(ApplicationStoppingError);
    expect((error as Error).message).toBe(
      "the app stopped before the execution ended and its store did not answer: the execution is given up — it stays running: the next take of its lease continues it (another instance, or this application once it starts again)",
    );
    run.finish("late");
  });

  it("a caller whose run ends before the stop's end gets the run's outcome; after it ended it is no longer told anything", async () => {
    const runs = new LiveRuns();
    const deadline = new AbortController();
    runs.stopBy(deadline.signal);

    expect(await runs.untilAbandoned(Promise.resolve("done"))).toBe("done");
    await expect(runs.untilAbandoned(Promise.reject(new Error("failed")))).rejects.toThrow(
      "failed",
    );
    deadline.abort();
    await turn();
  });

  it("every caller waiting is told, once each", async () => {
    const runs = new LiveRuns();
    const deadline = new AbortController();
    runs.stopBy(deadline.signal);
    const callers = [1, 2, 3].map(() =>
      runs.untilAbandoned(new Promise<never>(() => undefined)).catch((error: unknown) => error),
    );

    deadline.abort();

    for (const error of await Promise.all(callers))
      expect(error).toBeInstanceOf(ApplicationStoppingError);
  });

  it("abandonable: the first and the resumed run are given up with the stop; the recovery, the end and the expiry are not", async () => {
    const runs = new LiveRuns();
    const deadline = new AbortController();
    runs.stopBy(deadline.signal);
    const never = () => new Promise<never>(() => undefined);
    const moves = {
      first: vi.fn(never),
      resumed: vi.fn(never),
      recovered: vi.fn(() => Promise.resolve("recovered")),
      endIfEnding: vi.fn(() => Promise.resolve(true)),
      expired: vi.fn(() => Promise.resolve(undefined)),
      unpaused: vi.fn(never),
    };
    const wrapped = runs.abandonable(moves as never);
    const call = (name: keyof typeof moves, ...args: unknown[]): Promise<unknown> =>
      Reflect.apply(
        Reflect.get(wrapped, name) as () => unknown,
        undefined,
        args,
      ) as Promise<unknown>;

    const first = call("first", "a", 1);
    const resumed = call("resumed", "b", 2);
    const unpaused = call("unpaused", "f", 6);
    expect(await call("recovered", "c", 3)).toBe("recovered");
    expect(await call("endIfEnding", "d", 4)).toBe(true);
    expect(await call("expired", "e", 5)).toBeUndefined();
    expect(moves.first).toHaveBeenCalledWith("a", 1);
    expect(moves.resumed).toHaveBeenCalledWith("b", 2);
    expect(moves.recovered).toHaveBeenCalledWith("c", 3);
    expect(moves.endIfEnding).toHaveBeenCalledWith("d", 4);
    expect(moves.expired).toHaveBeenCalledWith("e", 5);
    expect(moves.unpaused).toHaveBeenCalledWith("f", 6);
    deadline.abort();
    await expect(unpaused).rejects.toBeInstanceOf(ApplicationStoppingError);
    await expect(first).rejects.toBeInstanceOf(ApplicationStoppingError);
    await expect(resumed).rejects.toBeInstanceOf(ApplicationStoppingError);
  });

  it("a tree's lease is released at once while the instance is not stopping, and after the step bodies once it is", async () => {
    const runs = new LiveRuns();
    const closedOf = vi.fn(() => Promise.resolve());
    const steps = { closedOf } as never;

    await runs.stepsClosed(TREE, steps);
    expect(closedOf).not.toHaveBeenCalled();

    const deadline = new AbortController();
    runs.stopBy(deadline.signal);
    await runs.stepsClosed(TREE, undefined);
    expect(closedOf).not.toHaveBeenCalled();
    await runs.stepsClosed(TREE, steps);
    expect(closedOf).toHaveBeenCalledOnce();
    expect(closedOf).toHaveBeenCalledWith(TREE, deadline.signal);
  });
});

describe("#1366: what a cancel leaves in the record", () => {
  it("the cancelled error names the thread; the reason is the one the record carries", () => {
    const error = cancelledErrorOf("thread-9");

    expect(error).toBeInstanceOf(ExecutionCancelledError);
    expect(error.message).toBe('thread "thread-9" was cancelled');
    expect(CANCELLED_STOP_REASON).toBe("the run was cancelled");
  });

  it("the outcome of a cancelled run: failed, no reply, the path and the cost it had", () => {
    const outcome = {
      replyWith: "",
      status: "cancelled",
      stopReason: "the run was cancelled",
      route: ["a", "b"],
      steps: [],
      costUsd: usd(0.5),
    };

    expect(cancelledRecordOutcome(["a", "b"], usd(0.5))).toEqual(outcome);
    expect(cancelledOutcome({ path: ["a", "b"], cost: { totalUsd: usd(0.5) } } as never)).toEqual(
      outcome,
    );
  });

  it("what a run is given: the tracked signal, the owner, the configurable and the stream only when there is one", () => {
    const signal = new AbortController().signal;
    const configurable = { x: 1 };
    const onStream = vi.fn();

    expect(runOptionsOf({ ownerId: "ada", configurable }, signal)).toEqual({
      signal,
      ownerId: "ada",
      configurable,
    });
    expect("onStream" in runOptionsOf({ configurable }, signal)).toBe(false);
    expect(runOptionsOf({ configurable, onStream }, signal).onStream).toBe(onStream);
  });
});

describe("#1366: the indexes of the runs in flight are emptied as the runs end", () => {
  it("entered: a thread's set is kept while a run is in it and dropped with its last; a leave called again drops no newer set", () => {
    const index = new Map<string, Set<AbortController>>();
    const first = new AbortController();
    const second = new AbortController();
    const leaveFirst = entered(index, "t", first);
    const leaveSecond = entered(index, "t", second);
    expect([...(index.get("t") ?? [])]).toEqual([first, second]);

    leaveFirst();
    expect([...(index.get("t") ?? [])]).toEqual([second]);
    leaveSecond();
    expect(index.size).toBe(0);

    // a run of the same thread begun since: its set is its own, whatever an old leave does
    const third = new AbortController();
    const leaveThird = entered(index, "t", third);
    leaveSecond();
    expect([...(index.get("t") ?? [])]).toEqual([third]);
    leaveThird();
    expect(index.size).toBe(0);
  });

  it("counted: each id counted once per run, out when its last run ends, the thread's map dropped with its last id; a stale count out drops no newer map", () => {
    const index = new Map<string, Map<string, number>>();
    const leaveA = counted(index, "t", "root-1");
    const leaveB = counted(index, "t", "root-1");
    const leaveC = counted(index, "t", "root-2");
    expect(Object.fromEntries(index.get("t") ?? [])).toEqual({ "root-1": 2, "root-2": 1 });

    leaveA();
    expect(Object.fromEntries(index.get("t") ?? [])).toEqual({ "root-1": 1, "root-2": 1 });
    leaveB();
    expect(Object.fromEntries(index.get("t") ?? [])).toEqual({ "root-2": 1 });
    leaveC();
    expect(index.size).toBe(0);

    const leaveD = counted(index, "t", "root-3");
    leaveC();
    expect(Object.fromEntries(index.get("t") ?? [])).toEqual({ "root-3": 1 });
    leaveD();
    expect(index.size).toBe(0);
  });

  it("abortAll: no runs, or an empty set of them, is false and aborts nothing", () => {
    expect(abortAll(undefined, "t")).toBe(false);
    expect(abortAll(new Set(), "t")).toBe(false);
    const run = new AbortController();
    expect(abortAll(new Set([run]), "t")).toBe(true);
    expect(run.signal.aborted).toBe(true);
  });
});
