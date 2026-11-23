/**
 * #1366: the slots of a tree shared by the instances — a capped subtree is a lease of its own under its own key, a
 * slot is given back when its execution's last step ends (and taken anew by the next step), an aborted take asks
 * the store for nothing, a full tree stops the look at its first waiter, a lease stops being renewed once released,
 * and while steps wait there is exactly one look timer, none once nobody waits. Run against the in-memory store
 * and SQLite, one clock.
 */
import { describe, expect, it } from "vitest";
import type { SlotClaim } from "../../../src/flow/runtime/launch/launch-registry.js";
import { SharedTreeSlots } from "../../../src/flow/runtime/launch/shared-tree-slots.js";
import type { RateLimitRepository } from "../../../src/index.js";
import { InMemoryRateLimitRepository } from "../../../src/infrastructure/rate-limit.repository.js";
import { SqliteRateLimitRepository } from "../../../src/infrastructure/sqlite/sqlite-rate-limit.repository.js";
import { withTarget } from "../../../src/testing/contracts/instance-context.js";
import type { VirtualClock } from "../../../src/testing/clock.js";
import { minutes, seconds } from "../../../src/units/index.js";
import { storeTargets } from "../../infrastructure/contracts/store-kinds.js";

const kinds = storeTargets<RateLimitRepository>(
  ({ clock, application, database }) =>
    new InMemoryRateLimitRepository(clock, application, database),
  ({ clock, application, connection }) =>
    new SqliteRateLimitRepository(connection(), clock, application),
);

const TREE = "tree:acme:root-1";
const open = new AbortController().signal;

const claimOf = (executionId: string, subtrees: SlotClaim["subtrees"] = []): SlotClaim => ({
  executionId,
  depth: 2,
  closesBranch: false,
  subtrees,
});

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** What a take got so far. */
const watch = (taken: Promise<unknown>) => {
  const state: { hold?: { release(): void }; done: boolean } = { done: false };
  void taken.then((hold) => {
    state.hold = hold as { release(): void } | undefined;
    state.done = true;
  });
  return state;
};

/** The repository with its calls to `method` counted. */
function counting(inner: RateLimitRepository, method: "acquire" | "renew") {
  const calls = { count: 0 };
  const repository = new Proxy(inner, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (key !== method) return fn.bind(target);
      return (...args: unknown[]) => {
        calls.count += 1;
        return fn.apply(target, args);
      };
    },
  });
  return { repository, calls };
}

/** The clock with the sleeps of `delay` it was asked for remembered: how many still wait. */
function sleepsOf(inner: VirtualClock, delay: number, onAbort?: () => void) {
  const sleeps: { signal: AbortSignal | undefined; isDone: boolean }[] = [];
  const clock = new Proxy(inner, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (key !== "sleep") return fn.bind(target);
      return (wait: number, signal?: AbortSignal) => {
        const sleep = { signal, isDone: false };
        if (wait === delay) {
          sleeps.push(sleep);
          if (onAbort !== undefined) signal?.addEventListener("abort", onAbort, { once: true });
        }
        const done = fn.call(target, wait, signal) as Promise<void>;
        void done.then(() => {
          sleep.isDone = true;
        });
        return done;
      };
    },
  });
  return { clock, waiting: () => sleeps.filter((sleep) => !sleep.isDone).length };
}

describe.each(kinds)("#1366: the slots of a shared tree ($name)", (target) => {
  const slotsOf = (rateLimits: RateLimitRepository, clock: VirtualClock, cap: number) =>
    new SharedTreeSlots({ rateLimits, clock, tenantId: "acme" }, "root-1", cap);

  it(
    "a capped subtree is a lease under its own key, one per subtree",
    withTarget(target, async ({ clock, first, second }) => {
      const here = slotsOf(first, clock, 5);
      const s1 = [{ executionId: "s1", maxConcurrentExecutions: 1 }];
      const s2 = [{ executionId: "s2", maxConcurrentExecutions: 1 }];
      await here.take(claimOf("a", s1), open);
      const sameSubtree = watch(here.take(claimOf("b", s1), open));
      const otherSubtree = watch(here.take(claimOf("c", s2), open));
      await settled();

      const leaseOfS1 = await second.acquire(`${TREE}:subtree:s1`, 1, seconds(30));
      const leaseOfS2 = await second.acquire(`${TREE}:subtree:s2`, 1, seconds(30));

      expect(leaseOfS1).toBeUndefined();
      expect(leaseOfS2).toBeUndefined();
      expect(sameSubtree.done).toBe(false);
      expect(otherSubtree.done).toBe(true);
    }),
  );

  it(
    "an execution whose last step ended gives its slot back and takes one anew for its next step",
    withTarget(target, async ({ clock, first, second }) => {
      const here = slotsOf(first, clock, 1);
      const one = await here.take(claimOf("a"), open);
      one?.release();
      await settled();
      const freed = await second.acquire(TREE, 1, seconds(30));
      if (freed !== undefined) await second.release(freed);

      await here.take(claimOf("a"), open);
      const elsewhere = await second.acquire(TREE, 1, seconds(30));

      expect(freed).toBeDefined();
      expect(elsewhere).toBeUndefined();
    }),
  );

  it(
    "a take whose signal is aborted holds nothing and does not look for a slot for the others",
    withTarget(target, async ({ clock, first, second }) => {
      const here = slotsOf(first, clock, 1);
      const other = await second.acquire(TREE, 1, minutes(5));
      const waiting = watch(here.take(claimOf("b"), open));
      await settled();
      if (other !== undefined) await second.release(other);

      const refused = await here.take(claimOf("c"), AbortSignal.abort());
      await settled();

      expect(refused).toBeUndefined();
      expect(waiting.done).toBe(false);
    }),
  );

  it(
    "two steps asking at once both get their slots",
    withTarget(target, async ({ clock, first }) => {
      const { repository, calls } = counting(first, "acquire");
      const here = slotsOf(repository, clock, 2);
      const a = watch(here.take(claimOf("a"), open));
      const b = watch(here.take(claimOf("b"), open));
      await settled();

      expect(a.done).toBe(true);
      expect(b.done).toBe(true);
      expect(calls.count).toBe(2); // one lease each: the looks do not overlap
    }),
  );

  it(
    "a full tree stops the look at its first waiter",
    withTarget(target, async ({ clock, first, second }) => {
      const { repository, calls } = counting(first, "acquire");
      const here = slotsOf(repository, clock, 1);
      await second.acquire(TREE, 1, minutes(5));
      void here.take(claimOf("b"), open);
      await settled();
      void here.take(claimOf("c"), open);
      await settled();

      expect(calls.count).toBe(2);
    }),
  );

  it(
    "a lease is not renewed once it is released",
    withTarget(target, async ({ clock, first }) => {
      const { repository, calls } = counting(first, "renew");
      const here = slotsOf(repository, clock, 1);
      const hold = await here.take(claimOf("a"), open);
      hold?.release();
      await settled();

      await clock.advance(minutes(3));

      expect(calls.count).toBe(0);
    }),
  );

  it(
    "while steps wait there is one look timer; once nobody waits, none",
    withTarget(target, async ({ clock, first }) => {
      const spy = sleepsOf(clock, seconds(1));
      const here = slotsOf(first, spy.clock, 1);
      const a = await here.take(claimOf("a"), open);
      const b = watch(here.take(claimOf("b"), open));
      await settled();
      const c = watch(here.take(claimOf("c"), open));
      await settled();
      const whileTwoWait = spy.waiting();

      a?.release();
      await settled();
      b.hold?.release();
      await settled();
      c.hold?.release();
      await settled();

      expect(whileTwoWait).toBe(1);
      expect(b.done).toBe(true);
      expect(c.done).toBe(true);
      expect(spy.waiting()).toBe(0);
    }),
  );

  it(
    "a waiter that leaves stops the look timer at the next look",
    withTarget(target, async ({ clock, first, second }) => {
      const spy = sleepsOf(clock, seconds(1));
      const here = slotsOf(first, spy.clock, 1);
      const other = await second.acquire(TREE, 1, minutes(5));
      const cancel = new AbortController();
      void here.take(claimOf("b"), cancel.signal);
      await settled();
      cancel.abort();
      await settled();

      await clock.advance(seconds(1));
      await settled();

      expect(other).toBeDefined();
      expect(spy.waiting()).toBe(0);
    }),
  );

  it(
    "a look timer that was stopped does not make a look of its own",
    withTarget(target, async ({ clock, first }) => {
      const { repository, calls } = counting(first, "acquire");
      let askAgain: () => void = () => undefined;
      const spy = sleepsOf(clock, seconds(1), () => {
        askAgain();
      });
      const here = slotsOf(repository, spy.clock, 1);
      askAgain = () => {
        void here.take(claimOf("c"), open); // arrives as the timer stops, the tree is full
      };
      const a = await here.take(claimOf("a"), open);
      void here.take(claimOf("b"), open);
      await settled();
      a?.release(); // b gets the slot, nobody else waits: the timer stops, then c comes
      await settled();

      expect(calls.count).toBe(4); // a, b refused, b, and one look for c
    }),
  );
});
