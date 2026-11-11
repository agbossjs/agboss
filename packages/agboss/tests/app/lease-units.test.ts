/**
 * #633 (takeover shard) — the holder's side of a takeover on its own: a step whose take back fails
 * leaves no step counted, a release waits for the latest bound of its attempts and leaves no timer
 * behind, a take of work already over asks the store nothing (or gives the lease back at once and
 * wakes the waiters), every wait for a lease closes its watch, a fenced error behind a driver's is
 * a hand-over, and a holder taken at a new token stops answering for the old one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { executionLeasesOf } from "../../src/app/execution-leases.js";
import {
  fencedErrorOf,
  FencedHolders,
  handedOverOf,
  isHandedOver,
  recordedHandOver,
} from "../../src/app/handed-over.js";
import { LeaseAttempts, LeaseYields } from "../../src/app/lease-yields.js";
import {
  ExecutionFencedError,
  ExecutionLeaseLostError,
  scopeKeyOf,
} from "../../src/app/lease-lost.js";
import { HandOverSite } from "../../src/infrastructure/execution-audit-log.repository.js";
import { leaseReleases } from "../../src/app/lease-releases.js";
import type { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { treeKeyOf } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/index.js";
import { minutes, seconds, type Milliseconds } from "../../src/units/index.js";

/** A clock that keeps the signal of every sleep it was asked for. */
class RecordingClock extends VirtualClock {
  readonly signals: (AbortSignal | undefined)[] = [];

  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return super.sleep(delay, signal);
  }
}

const flushed = () => new Promise((resolve) => setImmediate(resolve));
const never = (): Promise<void> => new Promise(() => undefined);
const noStep = (): Promise<() => void> => Promise.resolve(() => undefined);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#633: LeaseYields", () => {
  it("a step whose take back failed is not counted: the next wait yields", async () => {
    const moves: boolean[] = [];
    let fails = true;
    const yields = new LeaseYields((shouldYield) => {
      moves.push(shouldYield);
      if (fails) {
        fails = false;
        return Promise.reject(new Error("reclaim refused"));
      }
      return Promise.resolve();
    });

    await expect(yields.enterStep()).rejects.toThrow("reclaim refused");
    await yields.startWaiting();

    expect(moves).toEqual([false, true]);
  });
});

describe("#633: LeaseAttempts", () => {
  it("the wait ends at the latest attempt's bound, not the earliest", async () => {
    const clock = new VirtualClock();
    const attempts = new LeaseAttempts(clock);
    attempts.keep(never(), minutes(1), noStep);
    attempts.keep(never(), minutes(2), noStep);
    let isSettled: boolean | undefined;
    void attempts.settled(new AbortController().signal).then((value) => (isSettled = value));

    await clock.advance(seconds(61));
    await flushed();
    const afterTheFirst = isSettled;
    await clock.advance(seconds(60));
    await flushed();

    expect(afterTheFirst).toBeUndefined();
    expect(isSettled).toBe(false);
  });

  it("an attempt that settles: its bound's timer is ended at once", async () => {
    const clock = new RecordingClock();
    const attempts = new LeaseAttempts(clock);
    let settle = (): void => undefined;
    attempts.keep(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
      minutes(2),
      noStep,
    );
    const [bound] = clock.signals;

    settle();
    await flushed();

    expect(bound?.aborted).toBe(true);
  });

  it("a wait that ended: its timer is ended too", async () => {
    const clock = new RecordingClock();
    const attempts = new LeaseAttempts(clock);
    let settle = (): void => undefined;
    attempts.keep(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
      minutes(2),
      noStep,
    );
    const waiting = attempts.settled(new AbortController().signal);
    const waited = clock.signals.at(-1);
    settle();

    expect(await waiting).toBe(true);
    expect(waited?.aborted).toBe(true);
  });
});

/** A lease store that gives `lease` (or none) and records what it was asked. */
function storeOf(lease?: object) {
  const acquire = vi.fn(() => Promise.resolve(lease));
  const release = vi.fn(() => Promise.resolve(true));
  return {
    acquire,
    release,
    repository: { acquire, release } as never,
  };
}

const TREE = { tenantId: "acme", rootExecutionId: "root-1" };
const reason = "recovered" as never;

describe("#633: a take of work already over (#520)", () => {
  it("over before the store is asked: nothing asked", async () => {
    const { repository, acquire } = storeOf();
    const leases = executionLeasesOf(repository, new VirtualClock());

    const held = await leases.tryHold(TREE, { reason, isOver: () => Promise.resolve(true) });

    expect(held).toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("over once the store gave the lease: given back, and this process's waiters woken", async () => {
    const lease = { tenantId: "acme", rootExecutionId: "root-1", token: 1 };
    const { repository, release } = storeOf(lease);
    const notify = vi.spyOn(leaseReleases, "notify");
    const leases = executionLeasesOf(repository, new VirtualClock());
    const looks = [false, true];

    const held = await leases.tryHold(TREE, {
      reason,
      isOver: () => Promise.resolve(looks.shift() ?? true),
    });

    expect(held).toBeUndefined();
    expect(release).toHaveBeenCalledWith(lease);
    expect(notify).toHaveBeenCalledWith(treeKeyOf("acme", "root-1"));
  });

  it("a look that fails is not over: the store is asked", async () => {
    const { repository, acquire } = storeOf();
    const leases = executionLeasesOf(repository, new VirtualClock());

    await leases.tryHold(TREE, { reason, isOver: () => Promise.reject(new Error("down")) });

    expect(acquire).toHaveBeenCalledOnce();
  });
});

describe("#633: a call waiting for a tree's lease", () => {
  it("closes its watch on every try, the last one too when its signal ends the wait", async () => {
    const closes: number[] = [];
    const watch = leaseReleases.watch.bind(leaseReleases);
    vi.spyOn(leaseReleases, "watch").mockImplementation((key) => {
      const opened = watch(key);
      return {
        wait: (retry, signal) => opened.wait(retry, signal),
        close: () => {
          closes.push(1);
          opened.close();
        },
      };
    });
    const { repository } = storeOf();
    const clock = new VirtualClock();
    const leases = executionLeasesOf(repository, clock);
    const caller = new AbortController();

    const holding = leases.hold(TREE, caller.signal);
    await clock.advance(seconds(1));
    await flushed();
    caller.abort(new Error("caller gone"));

    await expect(holding).rejects.toThrow("caller gone");
    expect(closes.length).toBe(2);
  });
});

describe("#633: hand-overs", () => {
  const fenced = (token: number) =>
    ExecutionFencedError.of({
      scopeKey: scopeKeyOf("acme", "root-1"),
      token,
      observedToken: token + 1,
    });

  it("a fenced error behind a driver's error is a hand-over", () => {
    expect(isHandedOver(new Error("driver failed", { cause: fenced(3) }))).toBe(true);
    expect(isHandedOver(new Error("driver failed"))).toBe(false);
  });

  it("a cause chain that loops, or an AggregateError that holds itself: walked once, nothing fenced", () => {
    const looped = new Error("looped");
    looped.cause = looped;
    const aggregate = new AggregateError([], "both");
    aggregate.errors.push(aggregate, looped);

    expect([fencedErrorOf(looped), fencedErrorOf(aggregate)]).toEqual([undefined, undefined]);
    const behind = fenced(4);
    expect(fencedErrorOf(new AggregateError([looped, new Error("x", { cause: behind })]))).toBe(
      behind,
    );
  });

  it("only an Error's cause is followed: a plain object's is not", () => {
    expect(fencedErrorOf({ cause: fenced(2) })).toBeUndefined();
  });

  it("a hand-over outside any frame, or under a lease that records none: as it is", () => {
    const lost = new ExecutionLeaseLostError("root-1");

    expect(recordedHandOver(lost, HandOverSite.Step, undefined)).toBe(lost);
    expect(recordedHandOver(lost, HandOverSite.Step, { execution: { lease: {} } } as never)).toBe(
      lost,
    );
  });

  it("a holder's forget never removes another holder's stop of the same scope and token", () => {
    const [first, second] = [vi.fn(), vi.fn()];
    const one = new FencedHolders(scopeKeyOf("acme", "root-1"), first);
    const other = new FencedHolders(scopeKeyOf("acme", "root-1"), second);

    one.hold(5);
    other.hold(5);
    one.forget();
    handedOverOf(fenced(5), undefined);
    other.forget();
    handedOverOf(fenced(5), undefined);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("a holder taken again at a new token no longer stops for the old one", () => {
    const stop = vi.fn();
    const holders = new FencedHolders(scopeKeyOf("acme", "root-1"), stop);

    holders.hold(1);
    holders.hold(2);
    handedOverOf(fenced(1), undefined);
    const forOld = stop.mock.calls.length;
    handedOverOf(fenced(2), undefined);
    holders.forget();

    expect(forOld).toBe(0);
    expect(stop).toHaveBeenCalledOnce();
  });
});
