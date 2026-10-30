import { expect } from "vitest";
import { FencedEffectStatus } from "../../infrastructure/fenced-effect.repository.js";
import type { ContractCase, ContractGroup } from "./define.js";
import {
  failing,
  keyOf,
  leaseOf,
  rejectionOf,
  writing,
  type FencedEffectStores,
  type WriteCount,
} from "./fenced-effect-data.js";

/** The fenced-effect contract's rollback and concurrency (#500 AC3). */

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectStores<TTransaction>>;

const throwingWriteRollsBack = <TTransaction>(): Case<TTransaction> => ({
  name: "a throwing write rolls its business row back, its error rethrown as it is; the next call runs it",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const key = keyOf(await leaseOf(first));
    const declined = new Error("the card was declined");

    const failed = await rejectionOf(
      first.effects.saveResultIfAbsent(key, failing(first.rows, "r1", declined)),
    );
    const after = await second.rows.committed();
    const retried = await second.effects.saveResultIfAbsent(key, writing(second.rows, "r2", count));

    expect(failed).toBe(declined);
    expect(after).toEqual([]);
    expect(retried).toMatchObject({
      status: FencedEffectStatus.Ran,
      result: { receipt: "r2" },
    });
  },
});

const rowSeenAfterCommit = <TTransaction>(): Case<TTransaction> => ({
  name: "a business row is seen by another instance only once the effect committed",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const key = keyOf(await leaseOf(first));
    const write = writing(first.rows, "r1", count);
    let during: Promise<readonly string[]> = Promise.resolve(["not read"]);

    await first.effects.saveResultIfAbsent(key, (transaction) => {
      const receipt = write(transaction);
      during = second.rows.committed();
      return receipt;
    });

    expect(await during).toEqual([]);
    expect(await second.rows.committed()).toEqual(["r1"]);
  },
});

const twoInstancesOneKey = <TTransaction>(): Case<TTransaction> => ({
  name: "AC3: two instances call one key at once: one Ran, one Replayed, the write runs once",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const key = keyOf(await leaseOf(first));

    const outcomes = await Promise.all([
      first.effects.saveResultIfAbsent(key, writing(first.rows, "r1", count)),
      second.effects.saveResultIfAbsent(key, writing(second.rows, "r2", count)),
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
      first.effects.saveResultIfAbsent(key, writing(first.rows, "r1", count)),
      first.effects.saveResultIfAbsent(key, writing(first.rows, "r2", count)),
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
      rejectionOf(first.effects.saveResultIfAbsent(key, failing(first.rows, "r1", declined))),
      rejectionOf(first.effects.saveResultIfAbsent(key, writing(first.rows, "r2", count))),
    ]);

    expect(errors).toEqual([declined, declined]);
    expect(count.runs).toBe(0);
  },
});

export const rollbackCases = <TTransaction>(): ContractGroup<FencedEffectStores<TTransaction>> => ({
  title: "rollback",
  cases: [throwingWriteRollsBack<TTransaction>(), rowSeenAfterCommit<TTransaction>()],
});

export const concurrencyCases = <TTransaction>(): ContractGroup<
  FencedEffectStores<TTransaction>
> => ({
  title: "concurrency",
  cases: [
    twoInstancesOneKey<TTransaction>(),
    oneInstanceJoins<TTransaction>(),
    joinedGetsError<TTransaction>(),
  ],
});
