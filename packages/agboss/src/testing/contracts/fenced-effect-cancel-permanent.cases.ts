import { expect } from "vitest";
import { ExecutionCancelFencedError } from "../../app/lease-lost.js";
import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import type { EffectKey } from "../../infrastructure/fenced-effect.repository.js";
import type { Clock } from "../../infrastructure/clock.js";
import { hours } from "../../units/index.js";
import type { ContractCase, ContractGroup } from "./define.js";
import { effectKeyForTesting } from "./effect-key.js";
import {
  keyOf,
  leaseOf,
  rejectionOf,
  treeOf,
  writing,
  type FencedEffectTarget,
  type WriteCount,
} from "./fenced-effect-data.js";

/**
 * A tree's cancel mark is permanent (#1117): it lives on the tree's lease row (#909), kept as the
 * lease rows and the execution ids are, and no retention pass lifts it — not at any cutoff, not
 * once the root's lease is retired, not across a release, a take or a takeover of the lease. A
 * child of a cancelled tree, live or taken later, stays fenced for good.
 */

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectTarget<TTransaction>>;

/** A cutoff a day after `clock`'s now: every row of the case is older than it. */
const farCutoff = (clock: Pick<Clock, "now">): Date => new Date(clock.now().getTime() + hours(24));

/** The key of `child`'s step in the tree of `root-1`. */
const childKey = (child: ExecutionLease): EffectKey =>
  effectKeyForTesting(keyOf(child), { rootExecutionId: "root-1" });

/** Both instances' retention passes at `cutoff`. */
const sweptBoth = async <TTransaction>(
  stores: readonly FencedEffectTarget<TTransaction>[],
  cutoff: Date,
): Promise<void> => {
  for (const { effects } of stores) await effects.deleteByStoredAtBefore(cutoff);
};

const childFencedAfterRootRetired = <TTransaction>(): Case<TTransaction> => ({
  name: "#1117: a cancel's mark is never lifted — the root's lease retired and every retention pass at any cutoff, a live child lease of the tree has its write refused, and so has a child lease taken after it",
  isFencing: true,
  run: async ({ clock, first, second }) => {
    const root = await leaseOf(first, "root-1", hours(1000));
    const child = await leaseOf(second, "child-1", hours(1000));
    await second.leases.requestCancel(treeOf(root));
    await clock.advance(hours(48));
    await first.leases.retire(root);
    await sweptBoth([first, second], farCutoff(clock));
    const later = await leaseOf(first, "child-2", hours(1000));
    const count: WriteCount = { runs: 0 };

    const ofChild = await rejectionOf(
      second.effects.runOnce(childKey(child), writing(second.rows, "child", count)),
    );
    const ofLater = await rejectionOf(
      first.effects.runOnce(childKey(later), writing(first.rows, "later", count)),
    );

    expect(ofChild).toBeInstanceOf(ExecutionCancelFencedError);
    expect(ofLater).toBeInstanceOf(ExecutionCancelFencedError);
    expect(count.runs).toBe(0);
    expect(await first.rows.committed()).toEqual([]);
  },
});

const markSurvivesLeaseMoves = <TTransaction>(): Case<TTransaction> => ({
  name: "#1117: the mark survives every release, take and takeover of the tree's lease — released and taken by the other instance, expired and taken over, retention passes between: each holder's write is refused",
  isFencing: true,
  run: async ({ clock, first, second }) => {
    const held = await leaseOf(first);
    await second.leases.requestCancel(treeOf(held));
    await first.leases.release(held);
    await sweptBoth([first, second], farCutoff(clock));
    const taken = await leaseOf(second);
    const count: WriteCount = { runs: 0 };
    const ofTaken = await rejectionOf(
      second.effects.runOnce(keyOf(taken), writing(second.rows, "taken", count)),
    );
    await clock.advance(hours(2));
    await sweptBoth([first, second], farCutoff(clock));
    const over = await leaseOf(first);

    const ofOver = await rejectionOf(
      first.effects.runOnce(keyOf(over), writing(first.rows, "over", count)),
    );

    expect([taken.token, over.token]).toEqual([2, 3]);
    expect(ofTaken).toBeInstanceOf(ExecutionCancelFencedError);
    expect(ofOver).toBeInstanceOf(ExecutionCancelFencedError);
    expect(count.runs).toBe(0);
  },
});

const earlyCancelSurvivesRetention = <TTransaction>(): Case<TTransaction> => ({
  name: "#1117: a cancel before the tree's first acquire survives the retention — a sweep long after it, then the first acquire is token 1 with no takeover, and its write is refused",
  isFencing: true,
  run: async ({ clock, first, second }) => {
    await second.leases.requestCancel({ tenantId: "default", rootExecutionId: "execution-1" });
    await clock.advance(hours(48));
    await sweptBoth([first, second], farCutoff(clock));
    const lease = await leaseOf(first);
    const count: WriteCount = { runs: 0 };

    const refused = await rejectionOf(
      first.effects.runOnce(keyOf(lease), writing(first.rows, "first", count)),
    );

    expect(lease.token).toBe(1);
    expect(lease.takenOverFrom).toBeUndefined();
    expect(refused).toBeInstanceOf(ExecutionCancelFencedError);
    expect(count.runs).toBe(0);
  },
});

/** The cancel mark is permanent (#1117). */
export const cancelPermanentCases = <TTransaction>(): ContractGroup<
  FencedEffectTarget<TTransaction>
> => ({
  title: "a tree's cancel mark is permanent (#1117)",
  cases: [
    childFencedAfterRootRetired<TTransaction>(),
    markSurvivesLeaseMoves<TTransaction>(),
    earlyCancelSurvivesRetention<TTransaction>(),
  ],
});
