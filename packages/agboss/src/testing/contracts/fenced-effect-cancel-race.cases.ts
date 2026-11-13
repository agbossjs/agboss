import { expect } from "vitest";
import { ExecutionCancelFencedError } from "../../app/lease-lost.js";
import { systemClock } from "../../infrastructure/clock.js";
import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import type { FencedEffectWork } from "../../infrastructure/fenced-effect.repository.js";
import type { Milliseconds } from "../../units/index.js";
import type { ContractCase, ContractGroup } from "./define.js";
import {
  keyOf,
  leaseOf,
  rejectionOf,
  treeOf,
  writing,
  type FencedEffectTarget,
  type Receipt,
  type WriteCount,
} from "./fenced-effect-data.js";

/**
 * A cancel asked while a fenced write's transaction is open (#909): the write lands and the cancel
 * answers after it, or the write is refused — never the write landing after the cancel answered.
 * Like the hand-over of #695, a store whose work must be synchronous (SQLite) runs no other call
 * while it does: the case is trivially true there, and the cancel comes after.
 */

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectTarget<TTransaction>>;

/** How long the work waits for the cancel to answer before it ends (real time: a bounded race). */
const CANCEL_WAIT = 500 as Milliseconds;

/** What the case saw: the cancel answered while the work ran, and its promise. */
interface Seen {
  isAnsweredDuringWork: boolean;
  cancel: Promise<void> | undefined;
}

/** The write's work: its row, then the cancel asked and waited for, a bounded while. */
function writingThroughCancel<TTransaction>(
  stores: { first: FencedEffectTarget<TTransaction>; second: FencedEffectTarget<TTransaction> },
  lease: ExecutionLease,
  seen: Seen,
): FencedEffectWork<TTransaction, Receipt> {
  const receipt: Receipt = { receipt: "holder" };
  return (transaction) => {
    const inserted = stores.first.rows.insert(transaction, "holder");
    if (inserted === undefined) return receipt;
    return inserted.then(async () => {
      seen.cancel ??= stores.second.leases.requestCancel(treeOf(lease));
      const done = await Promise.race([
        seen.cancel.then(() => true),
        systemClock.sleep(CANCEL_WAIT).then(() => false),
      ]);
      seen.isAnsweredDuringWork ||= done;
      return receipt;
    });
  };
}

const cancelDuringWrite = <TTransaction>(): Case<TTransaction> => ({
  name: "#909 AC2: a cancel asked while the write's transaction is open: the write landed and the cancel answered after it, or the write was refused — never the write landing after the cancel answered",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const seen: Seen = { isAnsweredDuringWork: false, cancel: undefined };

    const outcome = await first.effects
      .runOnce(keyOf(lease), writingThroughCancel({ first, second }, lease, seen))
      .then(
        () => "landed",
        (error: unknown) => (error instanceof ExecutionCancelFencedError ? "refused" : error),
      );
    // a store whose work is synchronous (SQLite) runs no other call meanwhile: the cancel comes after
    await (seen.cancel ?? second.leases.requestCancel(treeOf(lease)));

    expect({ isAnsweredDuringWork: seen.isAnsweredDuringWork, outcome }).not.toEqual({
      isAnsweredDuringWork: true,
      outcome: "landed",
    });
    expect(["landed", "refused"]).toContain(outcome);
    expect(await second.rows.committed()).toEqual(outcome === "landed" ? ["holder"] : []);
    const count: WriteCount = { runs: 0 };
    const later = await rejectionOf(
      second.effects.runOnce(keyOf(lease, "later"), writing(second.rows, "later", count)),
    );
    expect(later).toBeInstanceOf(ExecutionCancelFencedError);
    expect(count.runs).toBe(0);
  },
});

/** The cancel asked while a write's transaction is open. */
export const cancelRaceCases = <TTransaction>(): ContractGroup<
  FencedEffectTarget<TTransaction>
> => ({
  title: "a cancel asked while a write is open (#909)",
  cases: [cancelDuringWrite<TTransaction>()],
});
