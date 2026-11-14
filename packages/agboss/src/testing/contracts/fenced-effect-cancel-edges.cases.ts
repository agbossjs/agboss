import { expect } from "vitest";
import { ExecutionCancelFencedError, ExecutionFencedError } from "../../app/lease-lost.js";
import { FencedEffectStatus } from "../../infrastructure/fenced-effect.repository.js";
import { hours } from "../../units/index.js";
import type { ContractCase, ContractGroup } from "./define.js";
import { effectKeyForTesting } from "./effect-key.js";
import {
  businessKeyOf,
  keyOf,
  leaseOf,
  rejectionOf,
  treeOf,
  writing,
  type FencedEffectTarget,
  type WriteCount,
} from "./fenced-effect-data.js";

/**
 * The corners of the cancel as a fence of the fenced effect (#909): a child's key (its own lease)
 * is fenced by its root's cancel, a stale token is a hand-over before it is a cancel, a cancel
 * before the tree's first acquire fences the lease taken after it, and a business-key result
 * another tree stored replays for a cancelled one.
 */

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectTarget<TTransaction>>;

const childRefusedByRoot = <TTransaction>(): Case<TTransaction> => ({
  name: "#909 AC1: a child's key (its own lease, leaseExecutionId ≠ rootExecutionId) is refused by its root's cancel — the root need not hold a lease — and not by another root's",
  isFencing: true,
  run: async ({ first, second }) => {
    const child = await leaseOf(first, "child-1");
    const key = (rootExecutionId: string) => effectKeyForTesting(keyOf(child), { rootExecutionId });
    await second.leases.requestCancel({ tenantId: "default", rootExecutionId: "root-1" });
    const count: WriteCount = { runs: 0 };

    const refused = await rejectionOf(
      first.effects.runOnce(key("root-1"), writing(first.rows, "child", count)),
    );
    const ofAnotherRoot = await first.effects.runOnce(
      key("root-2"),
      writing(first.rows, "other-root", count),
    );

    expect(refused).toMatchObject({
      name: "ExecutionCancelFencedError",
      rootExecutionId: "root-1",
      leaseExecutionId: "child-1",
    });
    expect(ofAnotherRoot.status).toBe(FencedEffectStatus.Ran);
    expect(await second.rows.committed()).toEqual(["other-root"]);
  },
});

const staleTokenIsHandOver = <TTransaction>(): Case<TTransaction> => ({
  name: "#909: a stale token after a cancel is ExecutionFencedError, not the cancel — a zombie is a hand-over first; the new holder's write is the cancel's",
  isFencing: true,
  run: async ({ first, second }) => {
    const old = await leaseOf(first);
    await first.leases.release(old);
    const taken = await leaseOf(second);
    await second.leases.requestCancel(treeOf(taken));
    const count: WriteCount = { runs: 0 };

    const zombie = await rejectionOf(
      first.effects.runOnce(keyOf(old), writing(first.rows, "zombie", count)),
    );
    const holder = await rejectionOf(
      second.effects.runOnce(keyOf(taken), writing(second.rows, "holder", count)),
    );

    expect(zombie).toBeInstanceOf(ExecutionFencedError);
    expect(zombie).not.toBeInstanceOf(ExecutionCancelFencedError);
    expect(holder).toBeInstanceOf(ExecutionCancelFencedError);
    expect(count.runs).toBe(0);
  },
});

const cancelBeforeFirstAcquire = <TTransaction>(): Case<TTransaction> => ({
  name: "#909 AC1: a cancel before the tree's first acquire (no lease row yet) refuses the write of the lease taken after it",
  isFencing: true,
  run: async ({ first, second }) => {
    await second.leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-1" });
    const lease = await leaseOf(first);
    const count: WriteCount = { runs: 0 };

    const refused = await rejectionOf(
      first.effects.runOnce(keyOf(lease), writing(first.rows, "r1", count)),
    );

    expect(lease.token).toBe(1);
    expect(refused).toBeInstanceOf(ExecutionCancelFencedError);
    expect(count.runs).toBe(0);
  },
});

const businessResultOfAnotherTree = <TTransaction>(): Case<TTransaction> => ({
  name: "#909: a business-key result stored by another tree replays for a cancelled tree — a stored result is never refused",
  isFencing: true,
  run: async ({ first, second }) => {
    const other = await leaseOf(first, "execution-1");
    const cancelled = await leaseOf(first, "execution-2");
    const count: WriteCount = { runs: 0 };
    await first.effects.runOnce(businessKeyOf(other), writing(first.rows, "stored", count));
    await second.leases.requestCancel(treeOf(cancelled));

    const replayed = await second.effects.runOnce(
      businessKeyOf(cancelled, "fingerprint-a", "execution-2:charge-action:1"),
      writing(second.rows, "again", count),
    );

    expect(replayed).toMatchObject({
      status: FencedEffectStatus.Replayed,
      result: { receipt: "stored" },
    });
    expect(count.runs).toBe(1);
  },
});

const markOutlivesRetention = <TTransaction>(): Case<TTransaction> => ({
  name: "#909: a cancel's mark is not lifted by the retention while its tree has not retired — a sweep at any cutoff, long after the cancel, and the tree's write is still refused",
  isFencing: true,
  run: async ({ clock, first, second }) => {
    const lease = await leaseOf(first, "execution-1", hours(1000));
    await second.leases.requestCancel(treeOf(lease));
    await clock.advance(hours(48));
    const count: WriteCount = { runs: 0 };

    await second.effects.deleteByStoredAtBefore(new Date(clock.now().getTime() + hours(24)));
    const refused = await rejectionOf(
      first.effects.runOnce(keyOf(lease), writing(first.rows, "late", count)),
    );

    expect(refused).toBeInstanceOf(ExecutionCancelFencedError);
    expect(count.runs).toBe(0);
  },
});

/** The corners of the cancel as a fence of the fenced effect. */
export const cancelEdgeCases = <TTransaction>(): ContractGroup<
  FencedEffectTarget<TTransaction>
> => ({
  title: "a tree's cancel is a fence: its corners (#909)",
  cases: [
    childRefusedByRoot<TTransaction>(),
    staleTokenIsHandOver<TTransaction>(),
    cancelBeforeFirstAcquire<TTransaction>(),
    businessResultOfAnotherTree<TTransaction>(),
    markOutlivesRetention<TTransaction>(),
  ],
});
