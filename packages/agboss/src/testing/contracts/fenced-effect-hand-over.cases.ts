import { expect } from "vitest";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import { systemClock } from "../../infrastructure/clock.js";
import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import type { FencedEffectWork } from "../../infrastructure/fenced-effect.repository.js";
import type { Milliseconds } from "../../units/index.js";
import { ClockSkew } from "../clock-skew.js";
import type { ContractCase } from "./define.js";
import {
  CASE_LEASE,
  keyOf,
  leaseOf,
  type FencedEffectTarget,
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
 *
 * The same by expiry (#959): the lease is not released but runs out while the write is open, and the
 * other instance takes the expired lease. A store whose open write holds off a release but not a take
 * of an expired lease (its lock keyed on the released state) passes the first case and fails this one.
 */

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectTarget<TTransaction>>;

/** How long the work waits for the hand-over before it ends (real time: a bounded race, #523). */
const HAND_OVER_WAIT = 500 as Milliseconds;

/** What the case saw: the hand-over done while the work ran, and how the write ended. */
interface Seen {
  isHandedOverDuringWork: boolean;
  handOver: Promise<unknown> | undefined;
  /** Whether the write's work ran at all (a write refused at its check proves nothing). */
  isWorkRun: boolean;
}

/** How the lease changes hands: given up by its holder, or run out. */
enum HandOver {
  Release = "release",
  Expiry = "expiry",
}

/** The lease of the expiry case, and how long its work waits: past the lease's end by the store's time. */
const SHORT_LEASE = 300 as Milliseconds;
const PAST_EXPIRY = 350 as Milliseconds;

/** The attempts of the expiry case before it fails as untimed (a stalled runner refused the write at its check). */
const ATTEMPTS = 10;

/** The holder's write: its row, then the hand-over started and waited for, a bounded while. */
function writingThroughHandOver<TTransaction>(
  stores: { first: FencedEffectTarget<TTransaction>; second: FencedEffectTarget<TTransaction> },
  lease: ExecutionLease,
  seen: Seen,
  how: HandOver,
): FencedEffectWork<TTransaction, Receipt> {
  const receipt: Receipt = { receipt: "holder" };
  return (transaction) => {
    seen.isWorkRun = true;
    const inserted = stores.first.rows.insert(transaction, "holder");
    if (inserted === undefined) return receipt;
    return inserted.then(async () => {
      if (how === HandOver.Expiry) await systemClock.sleep(PAST_EXPIRY);
      seen.handOver ??= (async () => {
        if (how === HandOver.Release) await stores.first.leases.release(lease);
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

/** One attempt: the write run, the hand-over made inside it, and what the case asserts of both. */
async function attempt<TTransaction>(
  {
    first,
    second,
  }: { first: FencedEffectTarget<TTransaction>; second: FencedEffectTarget<TTransaction> },
  how: HandOver,
  executionId: string,
): Promise<boolean> {
  const lease = await leaseOf(
    first,
    executionId,
    how === HandOver.Expiry ? SHORT_LEASE : CASE_LEASE,
  );
  const seen: Seen = { isHandedOverDuringWork: false, handOver: undefined, isWorkRun: false };

  const outcome = await first.effects
    .runOnce(keyOf(lease), writingThroughHandOver({ first, second }, lease, seen, how))
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
  return seen.isWorkRun;
}

export const handOverDuringWrite = <TTransaction>(): Case<TTransaction> => ({
  name: "#695: the lease released and taken while its holder's write runs: the hand-over waits for the write, or the write is refused — never the take during the work and the write landing after it",
  isFencing: true,
  run: async (stores) => {
    await attempt(stores, HandOver.Release, "execution-1");
  },
});

export const expiryDuringWrite = <TTransaction>(): Case<TTransaction> => ({
  name: "#959: the lease running out and taken while its holder's write runs: the take waits for the write, or the write is refused — never the take of the expired lease during the work and the write landing after it",
  isFencing: true,
  // real time, the store's own clock: the lease runs out while the write is open
  databaseTime: { secondSkew: ClockSkew.none },
  run: async (stores) => {
    for (let round = 0; round < ATTEMPTS; round += 1)
      if (await attempt(stores, HandOver.Expiry, `execution-${String(round)}`)) return;
    throw new Error(
      `the write's work never ran in ${String(ATTEMPTS)} attempts: its lease ran out before its check each time`,
    );
  },
});
