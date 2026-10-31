import { expect } from "vitest";
import { IdempotencyKeyConflictError } from "../../infrastructure/fenced-effect-key.js";
import { FencedEffectStatus } from "../../infrastructure/fenced-effect.repository.js";
import type { ContractCase, ContractGroup } from "./define.js";
import {
  businessKeyOf,
  leaseOf,
  rejectionOf,
  writing,
  type FencedEffectStores,
  type WriteCount,
} from "./fenced-effect-data.js";

/**
 * The fenced-effect contract's empty fingerprint (#574): under a business key a fingerprint is any
 * text, the empty one too, and no fingerprint is none — two different requests, never one charge.
 * The store keeps `""` as `""` (a column that turns it into `NULL` replays it as none), and two
 * calls in flight on one instance, one with `""` and one with none, are not joined.
 */

type Case<TTransaction> = ContractCase<FencedEffectStores<TTransaction>>;

/** `null`: no fingerprint; `""`: the empty one. */
type Fingerprint = "" | null;

const nameOf = (fingerprint: Fingerprint): string =>
  fingerprint === null ? "none" : 'fingerprint ""';

const storedApart = <TTransaction>(
  written: Fingerprint,
  asked: Fingerprint,
): Case<TTransaction> => ({
  name: `#574: under one business key a call with ${nameOf(asked)} after one with ${nameOf(written)} is IdempotencyKeyConflictError: nothing runs`,
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    await first.effects.saveResultIfAbsent(
      businessKeyOf(await leaseOf(first, "execution-1"), written),
      writing(first.rows, "r1", count),
    );

    const refused = await rejectionOf(
      second.effects.saveResultIfAbsent(
        businessKeyOf(await leaseOf(second, "execution-2"), asked),
        writing(second.rows, "r2", count),
      ),
    );

    expect(refused).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(count.runs).toBe(1);
    expect(await first.rows.committed()).toEqual(["r1"]);
  },
});

const emptyReplaysEmpty = <TTransaction>(): Case<TTransaction> => ({
  name: '#574: under one business key fingerprint "" replays "": the store keeps the empty text, not none',
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    await first.effects.saveResultIfAbsent(
      businessKeyOf(await leaseOf(first, "execution-1"), ""),
      writing(first.rows, "r1", count),
    );

    const again = await second.effects.saveResultIfAbsent(
      businessKeyOf(await leaseOf(second, "execution-2"), ""),
      writing(second.rows, "r2", count),
    );

    expect(again).toEqual({
      status: FencedEffectStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
      replayedFrom: { executionId: "execution-1", nodeId: "charge-action", visitNumber: 1 },
    });
    expect(count.runs).toBe(1);
  },
});

const inFlightApart = <TTransaction>(
  leading: Fingerprint,
  following: Fingerprint,
): Case<TTransaction> => ({
  name: `#574: on one instance a call with ${nameOf(following)} in flight beside one with ${nameOf(leading)} is refused, not joined`,
  run: async ({ first }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);

    const outcomes = await Promise.allSettled([
      first.effects.saveResultIfAbsent(
        businessKeyOf(lease, leading),
        writing(first.rows, "r1", count),
      ),
      first.effects.saveResultIfAbsent(
        businessKeyOf(lease, following),
        writing(first.rows, "r2", count),
      ),
    ]);

    expect(outcomes[0]).toMatchObject({
      status: "fulfilled",
      value: { status: FencedEffectStatus.Ran },
    });
    expect(outcomes[1]).toMatchObject({
      status: "rejected",
      reason: expect.any(IdempotencyKeyConflictError) as unknown,
    });
    expect(count.runs).toBe(1);
    expect(await first.rows.committed()).toEqual(["r1"]);
  },
});

const racingApart = <TTransaction>(): Case<TTransaction> => ({
  name: '#574: two instances racing under one business key, one with fingerprint "" and one with none, write once and refuse the other',
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const [one, other] = [
      await leaseOf(first, "execution-1"),
      await leaseOf(second, "execution-2"),
    ];

    const outcomes = await Promise.allSettled([
      first.effects.saveResultIfAbsent(businessKeyOf(one, ""), writing(first.rows, "r1", count)),
      second.effects.saveResultIfAbsent(
        businessKeyOf(other, null),
        writing(second.rows, "r2", count),
      ),
    ]);

    const ran = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(ran).toMatchObject([{ value: { status: FencedEffectStatus.Ran } }]);
    expect(refused).toMatchObject([{ reason: expect.any(IdempotencyKeyConflictError) as unknown }]);
    expect(count.runs).toBe(1);
    expect(await first.rows.committed()).toHaveLength(1);
  },
});

/** The empty-fingerprint cases. */
export const fingerprintCases = <TTransaction>(): ContractGroup<
  FencedEffectStores<TTransaction>
> => ({
  title: "an empty fingerprint is not none",
  cases: [
    storedApart<TTransaction>("", null),
    storedApart<TTransaction>(null, ""),
    emptyReplaysEmpty<TTransaction>(),
    inFlightApart<TTransaction>("", null),
    inFlightApart<TTransaction>(null, ""),
    racingApart<TTransaction>(),
  ],
});
