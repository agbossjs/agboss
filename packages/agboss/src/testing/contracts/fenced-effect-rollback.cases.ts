import { expect } from "vitest";
import {
  FencedEffectStatus,
  type FencedEffectWork,
} from "../../infrastructure/fenced-effect.repository.js";
import type { ContractCase, ContractGroup } from "./define.js";
import {
  failing,
  keyOf,
  leaseOf,
  rejectionOf,
  writing,
  type FencedEffectBusinessRows,
  type FencedEffectTarget,
  type Receipt,
  type WriteCount,
} from "./fenced-effect-data.js";

/** The fenced-effect contract's rollback and concurrency (#500 AC3). */

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectTarget<TTransaction>>;

const throwingWriteRollsBack = <TTransaction>(): Case<TTransaction> => ({
  name: "a throwing write rolls its business row back, its error rethrown as it is; the next call runs it",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const key = keyOf(await leaseOf(first));
    const declined = new Error("the card was declined");

    const failed = await rejectionOf(
      first.effects.runOnce(key, failing(first.rows, "r1", declined)),
    );
    const after = await second.rows.committed();
    const retried = await second.effects.runOnce(key, writing(second.rows, "r2", count));

    expect(failed).toBe(declined);
    expect(after).toEqual([]);
    expect(retried).toMatchObject({
      status: FencedEffectStatus.Ran,
      result: { receipt: "r2" },
    });
  },
});

/**
 * A write that inserts `row`, and — still in the effect's transaction, before the effect commits —
 * has `reader` read the rows it sees, into `seen`. A write that may wait (a promise from the
 * insert) waits for the read's answer, so the read has taken its snapshot before the commit — not
 * merely been sent (#898: on PostgreSQL the reader's connection is not ordered with the writer's
 * `COMMIT`). A write that must be synchronous (SQLite) cannot wait: its store answers the read in
 * the call, on the one thread, before the write returns.
 */
const writingSeenBy =
  <TTransaction>(
    rows: FencedEffectBusinessRows<TTransaction>,
    reader: FencedEffectBusinessRows<TTransaction>,
    row: string,
    seen: { rows: readonly string[] | undefined },
  ): FencedEffectWork<TTransaction, Receipt> =>
  (transaction) => {
    const receipt: Receipt = { receipt: row };
    const inserted = rows.insert(transaction, row);
    if (inserted === undefined) {
      void reader.committed().then((found) => (seen.rows = found));
      return receipt;
    }
    return inserted
      .then(() => reader.committed())
      .then((found) => {
        seen.rows = found;
        return receipt;
      });
  };

const rowSeenAfterCommit = <TTransaction>(): Case<TTransaction> => ({
  name: "a business row is seen by another instance only once the effect committed",
  run: async ({ first, second }) => {
    const key = keyOf(await leaseOf(first));
    const seen: { rows: readonly string[] | undefined } = { rows: undefined };

    await first.effects.runOnce(key, writingSeenBy(first.rows, second.rows, "r1", seen));
    await Promise.resolve();

    expect(seen.rows).toEqual([]);
    expect(await second.rows.committed()).toEqual(["r1"]);
  },
});

const twoInstancesOneKey = <TTransaction>(): Case<TTransaction> => ({
  name: "AC3: two instances call one key at once: one Ran, one Replayed, the write runs once",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const key = keyOf(await leaseOf(first));

    const outcomes = await Promise.all([
      first.effects.runOnce(key, writing(first.rows, "r1", count)),
      second.effects.runOnce(key, writing(second.rows, "r2", count)),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      FencedEffectStatus.Ran,
      FencedEffectStatus.Replayed,
    ]);
    expect(new Set(outcomes.map((outcome) => outcome.result.receipt)).size).toBe(1);
    expect(count.runs).toBe(1);
  },
});

const oneInstanceJoins = <TTransaction>(): Case<TTransaction> => ({
  name: "AC3: two calls on one key of one instance at once: the second joins the first (Joined), the write runs once",
  run: async ({ first }) => {
    const count: WriteCount = { runs: 0 };
    const key = keyOf(await leaseOf(first));

    const outcomes = await Promise.all([
      first.effects.runOnce(key, writing(first.rows, "r1", count)),
      first.effects.runOnce(key, writing(first.rows, "r2", count)),
    ]);

    expect(outcomes).toEqual([
      { status: FencedEffectStatus.Ran, result: { receipt: "r1" }, token: 1 },
      { status: FencedEffectStatus.Joined, result: { receipt: "r1" }, token: 1 },
    ]);
    expect(count.runs).toBe(1);
  },
});

const joinedGetsError = <TTransaction>(): Case<TTransaction> => ({
  name: "AC3: a joined call gets the first call's error",
  run: async ({ first }) => {
    const count: WriteCount = { runs: 0 };
    const key = keyOf(await leaseOf(first));
    const declined = new Error("the card was declined");

    const errors = await Promise.all([
      rejectionOf(first.effects.runOnce(key, failing(first.rows, "r1", declined))),
      rejectionOf(first.effects.runOnce(key, writing(first.rows, "r2", count))),
    ]);

    expect(errors).toEqual([declined, declined]);
    expect(count.runs).toBe(0);
  },
});

export const rollbackCases = <TTransaction>(): ContractGroup<FencedEffectTarget<TTransaction>> => ({
  title: "rollback",
  cases: [throwingWriteRollsBack<TTransaction>(), rowSeenAfterCommit<TTransaction>()],
});

export const concurrencyCases = <TTransaction>(): ContractGroup<
  FencedEffectTarget<TTransaction>
> => ({
  title: "concurrency",
  cases: [
    twoInstancesOneKey<TTransaction>(),
    oneInstanceJoins<TTransaction>(),
    joinedGetsError<TTransaction>(),
  ],
});
