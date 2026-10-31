import { expect } from "vitest";
import { ExecutionFencedError } from "../../app/lease-lost.js";
import { FencedEffectStatus } from "../../infrastructure/fenced-effect.repository.js";
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

/** The fenced-effect contract's writes, replays and refusals (#500 AC1, AC2). */

/** A lease shorter than the case's moves of the clock: a takeover. */
const SHORT = seconds(30);

/** One case of the contract, for a store of any transaction. */
type Case<TTransaction> = ContractCase<FencedEffectStores<TTransaction>>;

const unseenKeyRuns = <TTransaction>(): Case<TTransaction> => ({
  name: "AC1: an unseen key runs the write once and returns Ran with its result and token",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const key = keyOf(await leaseOf(first));

    const outcome = await first.effects.saveResultIfAbsent(key, writing(first.rows, "r1", count));

    expect(outcome).toEqual({
      status: FencedEffectStatus.Ran,
      result: { receipt: "r1" },
      token: 1,
    });
    expect(count.runs).toBe(1);
    expect(await second.rows.committed()).toEqual(["r1"]);
  },
});

const sameKeyReplays = <TTransaction>(): Case<TTransaction> => ({
  name: "AC1: the same key under the same token returns Replayed with the same JSON, the write not run",
  run: async ({ first, second }) => {
    const count: WriteCount = { runs: 0 };
    const key = keyOf(await leaseOf(first));
    await first.effects.saveResultIfAbsent(key, writing(first.rows, "r1", count));

    const again = await second.effects.saveResultIfAbsent(key, writing(second.rows, "r2", count));

    expect(again).toEqual({
      status: FencedEffectStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
    });
    expect(count.runs).toBe(1);
    expect(await first.rows.committed()).toEqual(["r1"]);
  },
});

const newerLeaseReplays = <TTransaction>(): Case<TTransaction> => ({
  name: "AC1: the same key under a newer lease (the step run again after a takeover) returns Replayed with the first token",
  run: async ({ clock, first, second }) => {
    const count: WriteCount = { runs: 0 };
    const old = await leaseOf(first, "execution-1", SHORT);
    await first.effects.saveResultIfAbsent(keyOf(old), writing(first.rows, "r1", count));
    await clock.advance(seconds(31));
    const taken = await leaseOf(second, "execution-1", SHORT);

    const replay = await second.effects.saveResultIfAbsent(
      keyOf(taken),
      writing(second.rows, "r2", count),
    );

    expect(taken.leaseEpoch).toBe(2);
    expect(replay).toEqual({
      status: FencedEffectStatus.Replayed,
      result: { receipt: "r1" },
      token: 1,
    });
    expect(count.runs).toBe(1);
  },
});

const lowerTokenRefused = <TTransaction>(): Case<TTransaction> => ({
  name: "AC2: a lower token is refused even when its key exists: the write not run, the stored result not returned",
  run: async ({ clock, first, second }) => {
    const count: WriteCount = { runs: 0 };
    const old = await leaseOf(first, "execution-1", SHORT);
    await first.effects.saveResultIfAbsent(keyOf(old), writing(first.rows, "r1", count));
    await clock.advance(seconds(31));
    const taken = await leaseOf(second, "execution-1", SHORT);
    await second.effects.saveResultIfAbsent(keyOf(taken), writing(second.rows, "r2", count));

    const refused = await rejectionOf(
      first.effects.saveResultIfAbsent(keyOf(old), writing(first.rows, "r3", count)),
    );

    expect(refused).toBeInstanceOf(ExecutionFencedError);
    expect(refused).toMatchObject({
      scopeKey: keyOf(old).scopeKey,
      token: 1,
      observedToken: 2,
    });
    expect(count.runs).toBe(1);
    expect(await second.rows.committed()).toEqual(["r1"]);
  },
});

const zombieFirstRefused = <TTransaction>(): Case<TTransaction> => ({
  name: "AC2: the zombie first — a token that is not the lease's epoch is refused before the new holder wrote anything",
  run: async ({ clock, first, second }) => {
    const count: WriteCount = { runs: 0 };
    const old = await leaseOf(first, "execution-1", SHORT);
    await clock.advance(seconds(31));
    const taken = await leaseOf(second, "execution-1", SHORT);

    const refused = await rejectionOf(
      first.effects.saveResultIfAbsent(keyOf(old), writing(first.rows, "zombie", count)),
    );
    const written = await second.effects.saveResultIfAbsent(
      keyOf(taken),
      writing(second.rows, "holder", count),
    );

    expect(refused).toMatchObject({ token: 1, observedToken: 2 });
    expect(written).toMatchObject({ status: FencedEffectStatus.Ran, token: 2 });
    expect(await first.rows.committed()).toEqual(["holder"]);
  },
});

const releasedLeaseRefused = <TTransaction>(): Case<TTransaction> => ({
  name: "AC2: a released lease is refused",
  run: async ({ first }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);
    await first.leases.release(lease);

    const refused = await rejectionOf(
      first.effects.saveResultIfAbsent(keyOf(lease), writing(first.rows, "r1", count)),
    );

    expect(refused).toMatchObject({ token: 1, observedToken: 1 });
    expect(count.runs).toBe(0);
  },
});

const noLeaseRefused = <TTransaction>(): Case<TTransaction> => ({
  name: "AC2: a scope without a lease is refused, with no observed token",
  run: async ({ first }) => {
    const count: WriteCount = { runs: 0 };
    const lease = await leaseOf(first);
    const stranger = {
      ...keyOf(lease),
      leaseExecutionId: "execution-9",
      scopeKey: "default:execution-9",
    };

    const refused = await rejectionOf(
      first.effects.saveResultIfAbsent(stranger, writing(first.rows, "r1", count)),
    );

    expect(refused).toBeInstanceOf(ExecutionFencedError);
    expect(refused).toMatchObject({ token: 1, observedToken: undefined });
    expect(count.runs).toBe(0);
  },
});

export const writeCases = <TTransaction>(): ContractGroup<FencedEffectStores<TTransaction>> => ({
  title: "writes and replays",
  cases: [
    unseenKeyRuns<TTransaction>(),
    sameKeyReplays<TTransaction>(),
    newerLeaseReplays<TTransaction>(),
  ],
});

export const refusalCases = <TTransaction>(): ContractGroup<FencedEffectStores<TTransaction>> => ({
  title: "refusals",
  cases: [
    lowerTokenRefused<TTransaction>(),
    zombieFirstRefused<TTransaction>(),
    releasedLeaseRefused<TTransaction>(),
    noLeaseRefused<TTransaction>(),
  ],
});
