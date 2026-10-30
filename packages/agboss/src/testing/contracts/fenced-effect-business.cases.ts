import { expect } from "vitest";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import type { ExecutionLease } from "../../infrastructure/execution-lease.repository.js";
import { IdempotencyKeyConflictError } from "../../infrastructure/fenced-effect-key.js";
import {
  FencedEffectStatus,
  type FencedEffectKey,
} from "../../infrastructure/fenced-effect.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractCase, ContractGroup } from "./define.js";
import {
  keyOf,
  leaseOf,
  rejectionOf,
  writing,
  type FencedEffectStores,
  type WriteCount,
} from "./fenced-effect-data.js";

/**
 * The fenced-effect contract's business keys (#508): one row per tenant, name and business key,
 * whatever scope and step write it — the same fingerprint replays, another one is refused, a stale
 * token is refused even where the business key has a result, two instances racing write once.
 */

type Case<TTransaction> = ContractCase<FencedEffectStores<TTransaction>>;

/** The key of `lease`'s step under business key `order:42`, with `fingerprint` (`null`: none). */
const businessKeyOf = (
  lease: ExecutionLease,
  fingerprint: string | null = "fingerprint-a",
  step = `${lease.rootExecutionId}:charge-action:1`,
): FencedEffectKey => ({
  ...keyOf(lease, "charge", step),
  businessKey: "order:42",
  ...(fingerprint === null ? {} : { fingerprint }),
  origin: { executionId: lease.rootExecutionId, nodeId: "charge-action", visitNumber: 1 },
});

const twoScopesOnce = <TTransaction>(): Case<TTransaction> => ({
  name: "#508: one business key from two executions (two scopes) runs once; the second replays it, naming the first",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const one = await leaseOf(first, "execution-1");
    const other = await leaseOf(second, "execution-2");
    await first.effects.saveResultIfAbsent(businessKeyOf(one), writing(first.rows, "r1", count));

    const again = await second.effects.saveResultIfAbsent(
      businessKeyOf(other),
      writing(second.rows, "r2", count),
    );

    expect(again).toEqual({
      status: FencedEffectStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
      replayedFrom: { executionId: "execution-1", nodeId: "charge-action", visitNumber: 1 },
    });
    expect(count.runs).toBe(1);
    expect(await first.rows.committed()).toEqual(["r1"]);
  },
});

const sameStepNoOrigin = <TTransaction>(): Case<TTransaction> => ({
  name: "#508: the same step run again replays its business key without naming another step",
  run: async ({ first }) => {
    const count: WriteCount = { runs: 0 };
    const key = businessKeyOf(await leaseOf(first));
    await first.effects.saveResultIfAbsent(key, writing(first.rows, "r1", count));

    const again = await first.effects.saveResultIfAbsent(key, writing(first.rows, "r2", count));

    expect(again).toEqual({
      status: FencedEffectStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
    });
  },
});

const conflictRefused = <TTransaction>(): Case<TTransaction> => ({
  name: "#508 AC3: another fingerprint under one business key is IdempotencyKeyConflictError: nothing runs, nothing is written",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    await first.effects.saveResultIfAbsent(
      businessKeyOf(await leaseOf(first, "execution-1")),
      writing(first.rows, "r1", count),
    );

    const refused = await rejectionOf(
      second.effects.saveResultIfAbsent(
        businessKeyOf(await leaseOf(second, "execution-2"), "fingerprint-b"),
        writing(second.rows, "r2", count),
      ),
    );

    expect(refused).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(JSON.stringify(refused)).not.toContain("order:42");
    expect(count.runs).toBe(1);
    expect(await first.rows.committed()).toEqual(["r1"]);
  },
});

const noFingerprintIsOne = <TTransaction>(): Case<TTransaction> => ({
  name: "#508: a business key with no fingerprint replays one with none, and conflicts with one that has one",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    await first.effects.saveResultIfAbsent(
      businessKeyOf(await leaseOf(first, "execution-1"), null),
      writing(first.rows, "r1", count),
    );
    const other = await leaseOf(second, "execution-2");

    const replay = await second.effects.saveResultIfAbsent(
      businessKeyOf(other, null),
      writing(second.rows, "r2", count),
    );
    const refused = await rejectionOf(
      second.effects.saveResultIfAbsent(businessKeyOf(other), writing(second.rows, "r3", count)),
    );

    expect(replay.status).toBe(FencedEffectStatus.Replayed);
    expect(refused).toBeInstanceOf(IdempotencyKeyConflictError);
    expect(count.runs).toBe(1);
  },
});

const staleRefused = <TTransaction>(): Case<TTransaction> => ({
  name: "#508: a stale token is refused even when its business key has a stored result — the zombie gets no receipt",
  run: async ({ clock, first, second }) => {
    const count: WriteCount = { runs: 0 };
    const old = await leaseOf(first, "execution-1", seconds(30));
    await clock.advance(seconds(31));
    const taken = await leaseOf(second, "execution-1", seconds(30));
    await second.effects.saveResultIfAbsent(
      businessKeyOf(taken),
      writing(second.rows, "r1", count),
    );

    const refused = await rejectionOf(
      first.effects.saveResultIfAbsent(businessKeyOf(old), writing(first.rows, "zombie", count)),
    );

    expect(refused).toBeInstanceOf(ExecutionFencedError);
    expect(refused).not.toHaveProperty("result");
    expect(count.runs).toBe(1);
  },
});

const racingOnce = <TTransaction>(): Case<TTransaction> => ({
  name: "#508: two instances racing on one business key from two executions write once",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const [one, other] = [
      await leaseOf(first, "execution-1"),
      await leaseOf(second, "execution-2"),
    ];

    const outcomes = await Promise.all([
      first.effects.saveResultIfAbsent(businessKeyOf(one), writing(first.rows, "r1", count)),
      second.effects.saveResultIfAbsent(businessKeyOf(other), writing(second.rows, "r2", count)),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      FencedEffectStatus.Ran,
      FencedEffectStatus.Replayed,
    ]);
    expect(count.runs).toBe(1);
    expect(await first.rows.committed()).toHaveLength(1);
  },
});

const concurrentConflict = <TTransaction>(): Case<TTransaction> => ({
  name: "#508 AC3: a concurrent call with another fingerprint under one business key is refused, not joined",
  run: async ({ first }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);

    const outcomes = await Promise.allSettled([
      first.effects.saveResultIfAbsent(businessKeyOf(lease), writing(first.rows, "r1", count)),
      first.effects.saveResultIfAbsent(
        businessKeyOf(lease, "fingerprint-b"),
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
  },
});

const stepKeysApart = <TTransaction>(): Case<TTransaction> => ({
  name: "#508: a business key and the same step's own key are two rows",
  run: async ({ first }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);

    await first.effects.saveResultIfAbsent(keyOf(lease), writing(first.rows, "step", count));
    const business = await first.effects.saveResultIfAbsent(
      businessKeyOf(lease),
      writing(first.rows, "business", count),
    );

    expect(business.status).toBe(FencedEffectStatus.Ran);
    expect(count.runs).toBe(2);
  },
});

/** The business-key cases. */
export const businessKeyCases = <TTransaction>(): ContractGroup<
  FencedEffectStores<TTransaction>
> => ({
  title: "business keys",
  cases: [
    twoScopesOnce<TTransaction>(),
    sameStepNoOrigin<TTransaction>(),
    conflictRefused<TTransaction>(),
    noFingerprintIsOne<TTransaction>(),
    staleRefused<TTransaction>(),
    racingOnce<TTransaction>(),
    concurrentConflict<TTransaction>(),
    stepKeysApart<TTransaction>(),
  ],
});
