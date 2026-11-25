import { IdempotencyError } from "../../core/error-families/effect-errors.js";
import { expect } from "vitest";
import type { Clock } from "../../infrastructure/clock.js";
import {
  IdempotencyRunStatus,
  type EffectKey,
} from "../../infrastructure/fenced-effect.repository.js";
import { effectKeyForTesting } from "./effect-key.js";
import { minutes, seconds } from "../../units/index.js";
import type { ContractCase, ContractGroup } from "./define.js";
import {
  keyOf,
  leaseOf,
  rejectionOf,
  writing,
  type FencedEffectTarget,
  type WriteCount,
} from "./fenced-effect-data.js";

/** The fenced-effect contract's isolation, limits and housekeeping (#500). */

/** One case of the contract, for a store of any transaction. */
type Case = ContractCase<FencedEffectTarget>;

/** 64 KB of text and the quotes around it: one byte above the default `maxResultSize`. */
const OVERSIZED = "x".repeat(64 * 1024 - 1);

const namesApart = (): Case => ({
  name: "another name or idempotency key of the step is a row of its own",
  run: async ({ first }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);

    const outcomes = await Promise.all([
      first.effects.runOnce(keyOf(lease, "charge"), writing(first.rows, "a", count)),
      first.effects.runOnce(keyOf(lease, "notify"), writing(first.rows, "b", count)),
      first.effects.runOnce(
        keyOf(lease, "charge", "execution-1:charge-action:2"),
        writing(first.rows, "c", count),
      ),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      IdempotencyRunStatus.Ran,
      IdempotencyRunStatus.Ran,
      IdempotencyRunStatus.Ran,
    ]);
    expect([...(await first.rows.committed())].sort()).toEqual(["a", "b", "c"]);
  },
});

const scopesApart = (): Case => ({
  name: "another scope has its own mark: a newer token of one scope refuses nothing of another",
  run: async ({ clock, first, second }) => {
    const count: WriteCount = { runs: 0 };
    const other = await leaseOf(first, "execution-2", minutes(5));
    await leaseOf(first, "execution-1", seconds(30));
    await clock.advance(seconds(31));
    const taken = await leaseOf(second, "execution-1");
    await second.effects.runOnce(keyOf(taken), writing(second.rows, "a", count));

    const outcome = await first.effects.runOnce(keyOf(other), writing(first.rows, "b", count));

    expect(outcome).toMatchObject({ status: IdempotencyRunStatus.Ran, token: 1 });
  },
});

const oversizedRefused = (): Case => ({
  name: "a result above maxResultSize is refused and its write rolled back",
  run: async ({ first, second }) => {
    const key = keyOf(await leaseOf(first));

    const refused = await rejectionOf(
      first.effects.runOnce(key, () => {
        const inserted = first.rows.insert("r1");
        return inserted === undefined ? OVERSIZED : inserted.then(() => OVERSIZED);
      }),
    );

    expect(refused).toBeInstanceOf(IdempotencyError.ResultTooLarge);
    expect(refused).toMatchObject({
      effect: "charge",
      size: 64 * 1024 + 1,
      maxResultSize: 64 * 1024,
    });
    expect(await second.rows.committed()).toEqual([]);
  },
});

/** `key` expiring `after` the case's now (`null`: for good, `Ttl.Forever`). */
const expiringIn = (key: EffectKey, clock: Pick<Clock, "now">, after: number | null): EffectKey =>
  effectKeyForTesting(key, {
    expiresAt: after === null ? null : new Date(clock.now().getTime() + after),
  });

const deletionFollowsClock = (): Case => ({
  name: "deleteExpired removes the results whose expiry has come, on the Clock, and counts them; a result with no expiry (Ttl.Forever) stays",
  run: async ({ clock, first, second }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);
    const short = expiringIn(keyOf(lease, "short"), clock, minutes(5));
    const long = expiringIn(keyOf(lease, "long"), clock, minutes(50));
    const forever = expiringIn(keyOf(lease, "forever"), clock, null);
    for (const key of [short, long, forever])
      await first.effects.runOnce(key, writing(first.rows, key.name, count));
    await clock.advance(minutes(10));

    // the scope's mark keeps the latest expiry — Forever — so only the short result goes
    expect(await second.effects.deleteExpired(clock.now())).toBe(1);

    const status = async (key: EffectKey): Promise<IdempotencyRunStatus> =>
      (await first.effects.runOnce(key, writing(first.rows, `${key.name}2`, count))).status;
    expect(await status(short)).toBe(IdempotencyRunStatus.Ran);
    expect(await status(long)).toBe(IdempotencyRunStatus.Replayed);
    expect(await status(forever)).toBe(IdempotencyRunStatus.Replayed);
  },
});

const markKeepsLatestExpiry = (): Case => ({
  name: "a scope's mark keeps the latest expiry written under it: a short ttl never truncates a long one, Forever wins over any date",
  run: async ({ clock, first, second }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);
    const long = expiringIn(keyOf(lease, "long"), clock, minutes(50));
    const short = expiringIn(keyOf(lease, "short"), clock, minutes(5));
    await first.effects.runOnce(long, writing(first.rows, "l", count));
    await first.effects.runOnce(short, writing(first.rows, "s", count));
    await clock.advance(minutes(10));
    // the short result only: the mark still holds the long one's expiry
    expect(await second.effects.deleteExpired(clock.now())).toBe(1);
    await clock.advance(minutes(50));
    // the long result and the mark with it
    expect(await second.effects.deleteExpired(clock.now())).toBe(2);
  },
});

export const isolationCases = (): ContractGroup<FencedEffectTarget> => ({
  title: "isolation",
  cases: [namesApart(), scopesApart()],
});

export const housekeepingCases = (): ContractGroup<FencedEffectTarget> => ({
  title: "limits and housekeeping",
  cases: [oversizedRefused(), deletionFollowsClock(), markKeepsLatestExpiry()],
});
