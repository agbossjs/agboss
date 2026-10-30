import { expect } from "vitest";
import {
  FencedEffectResultTooLargeError,
  FencedEffectStatus,
} from "../../infrastructure/fenced-effect.repository.js";
import { minutes, seconds } from "../../units/index.js";
import type { ContractCase, ContractGroup } from "./define.js";
import {
  keyOf,
  leaseOf,
  rejectionOf,
  writing,
  type FencedEffectStores,
  type WriteCount,
} from "./fenced-effect-data.js";

/** The fenced-effect contract's isolation, limits and housekeeping (#500). */

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectStores<TTransaction>>;

/** 64 KB of text and the quotes around it: one byte above the default `maxResultSize`. */
const OVERSIZED = "x".repeat(64 * 1024 - 1);

const namesApart = <TTransaction>(): Case<TTransaction> => ({
  name: "another name or idempotency key of the step is a row of its own",
  run: async ({ first }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);

    const outcomes = await Promise.all([
      first.effects.saveResultIfAbsent(keyOf(lease, "charge"), writing(first.rows, "a", count)),
      first.effects.saveResultIfAbsent(keyOf(lease, "notify"), writing(first.rows, "b", count)),
      first.effects.saveResultIfAbsent(
        keyOf(lease, "charge", "execution-1:charge-action:2"),
        writing(first.rows, "c", count),
      ),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      FencedEffectStatus.Ran,
      FencedEffectStatus.Ran,
      FencedEffectStatus.Ran,
    ]);
    expect([...(await first.rows.committed())].sort()).toEqual(["a", "b", "c"]);
  },
});

const scopesApart = <TTransaction>(): Case<TTransaction> => ({
  name: "another scope has its own mark: a newer token of one scope refuses nothing of another",
  run: async ({ clock, first, second }) => {
    const count: WriteCount = { runs: 0 };
    const other = await leaseOf(first, "execution-2", minutes(5));
    await leaseOf(first, "execution-1", seconds(30));
    await clock.advance(seconds(31));
    const taken = await leaseOf(second, "execution-1");
    await second.effects.saveResultIfAbsent(keyOf(taken), writing(second.rows, "a", count));

    const outcome = await first.effects.saveResultIfAbsent(
      keyOf(other),
      writing(first.rows, "b", count),
    );

    expect(outcome).toMatchObject({ status: FencedEffectStatus.Ran, token: 1 });
  },
});

const oversizedRefused = <TTransaction>(): Case<TTransaction> => ({
  name: "a result above maxResultSize is refused and its write rolled back",
  run: async ({ first, second }) => {
    const key = keyOf(await leaseOf(first));

    const refused = await rejectionOf(
      first.effects.saveResultIfAbsent(key, (transaction) => {
        const inserted = first.rows.insert(transaction, "r1");
        return inserted === undefined ? OVERSIZED : inserted.then(() => OVERSIZED);
      }),
    );

    expect(refused).toBeInstanceOf(FencedEffectResultTooLargeError);
    expect(refused).toMatchObject({
      effect: "charge",
      size: 64 * 1024 + 1,
      maxResultSize: 64 * 1024,
    });
    expect(await second.rows.committed()).toEqual([]);
  },
});

const deletionFollowsClock = <TTransaction>(): Case<TTransaction> => ({
  name: "deleteByStoredAtBefore removes the results stored before its cutoff, on the Clock",
  run: async ({ clock, first, second }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);
    const early = keyOf(lease, "early");
    const late = keyOf(lease, "late");
    await first.effects.saveResultIfAbsent(early, writing(first.rows, "e", count));
    await clock.advance(minutes(10));
    await first.effects.saveResultIfAbsent(late, writing(first.rows, "l", count));

    await second.effects.deleteByStoredAtBefore(new Date("2026-01-05T09:05:00.000Z"));

    expect(
      (await first.effects.saveResultIfAbsent(early, writing(first.rows, "e2", count))).status,
    ).toBe(FencedEffectStatus.Ran);
    expect(
      (await first.effects.saveResultIfAbsent(late, writing(first.rows, "l2", count))).status,
    ).toBe(FencedEffectStatus.Replayed);
  },
});

export const isolationCases = <TTransaction>(): ContractGroup<
  FencedEffectStores<TTransaction>
> => ({
  title: "isolation",
  cases: [namesApart<TTransaction>(), scopesApart<TTransaction>()],
});

export const housekeepingCases = <TTransaction>(): ContractGroup<
  FencedEffectStores<TTransaction>
> => ({
  title: "limits and housekeeping",
  cases: [oversizedRefused<TTransaction>(), deletionFollowsClock<TTransaction>()],
});
