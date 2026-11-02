import { expect } from "vitest";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import { systemClock } from "../../infrastructure/clock.js";
import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import type { FencedEffectWork } from "../../infrastructure/fenced-effect.repository.js";
import type { Milliseconds } from "../../units/index.js";
import type { ContractCase } from "./define.js";
import {
  CASE_LEASE,
  keyOf,
  leaseOf,
  type FencedEffectStores,
  type Receipt,
} from "./fenced-effect-data.js";

/**
 * The lease handed over **while** its holder's fenced write runs (#695): the holder's check has
 * passed and its work is still running when the lease is released and the other instance takes it.
 * The race cases of the zombie write the same key on both sides, so a store whose result row (or
 * mark) is unique serializes them even when its lease check takes no lock; here the new holder
 * writes nothing, and only the lease decides. A sound store either makes the hand-over wait for the
 * write (the lease is locked by the check: the write lands before the take) or refuses the write
 * (the lease is checked again at the commit); never both the take granted while the work runs
 * **and** the write landing after it. A store whose work must be synchronous (SQLite) runs no other
 * call while it does: the case is trivially true there.
 */

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectStores<TTransaction>>;

/** How long the work waits for the hand-over before it ends (real time: a bounded race, #523). */
const HAND_OVER_WAIT = 500 as Milliseconds;

/** What the case saw: the hand-over done while the work ran, and how the write ended. */
interface Seen {
  isHandedOverDuringWork: boolean;
  handOver: Promise<unknown> | undefined;
}

/** The holder's write: its row, then the hand-over started and waited for, a bounded while. */
function writingThroughHandOver<TTransaction>(
  stores: { first: FencedEffectStores<TTransaction>; second: FencedEffectStores<TTransaction> },
  lease: ExecutionLease,
  seen: Seen,
): FencedEffectWork<TTransaction, Receipt> {
  const receipt: Receipt = { receipt: "holder" };
  return (transaction) => {
    const inserted = stores.first.rows.insert(transaction, "holder");
    if (inserted === undefined) return receipt;
    return inserted.then(async () => {
      seen.handOver ??= (async () => {
        await stores.first.leases.release(lease);
        return stores.second.leases.acquire("default", lease.rootExecutionId, CASE_LEASE);
      })();
      const done = await Promise.race([
        seen.handOver.then(() => true),
        systemClock.sleep(HAND_OVER_WAIT).then(() => false),
      ]);
      seen.isHandedOverDuringWork ||= done;
      return receipt;
    });
  };
}

export const handOverDuringWrite = <TTransaction>(): Case<TTransaction> => ({
  name: "#695: the lease released and taken while its holder's write runs: the hand-over waits for the write, or the write is refused — never the take during the work and the write landing after it",
  isFencing: true,
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const seen: Seen = { isHandedOverDuringWork: false, handOver: undefined };

    const outcome = await first.effects
      .saveResultIfAbsent(keyOf(lease), writingThroughHandOver({ first, second }, lease, seen))
      .then(
        () => "landed",
        (error: unknown) => (error instanceof ExecutionFencedError ? "refused" : error),
      );
    await seen.handOver;

    expect({ isHandedOverDuringWork: seen.isHandedOverDuringWork, outcome }).not.toEqual({
      isHandedOverDuringWork: true,
      outcome: "landed",
    });
    expect(["landed", "refused"]).toContain(outcome);
    expect(await second.rows.committed()).toEqual(outcome === "landed" ? ["holder"] : []);
  },
});
