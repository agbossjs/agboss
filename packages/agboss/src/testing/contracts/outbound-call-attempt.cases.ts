import { expect } from "vitest";
import {
  OutboundCallStatus,
  type OutboundCallState,
} from "../../infrastructure/outbound-call.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf } from "./fenced-effect-data.js";
import { recorded, type OutboundCallCase, type OutboundCallStores } from "./outbound-call-data.js";

/**
 * The outbound-call contract's new attempts (#505): `markPending` is a compare-and-set — the intent
 * moves to its next attempt and owner only while its status, attempt and attempt owner are as the
 * caller read them, in the fenced transaction; `false` and nothing changed otherwise. Two callers
 * that read one intent move it once: only one of them sends.
 */

const FAILURE = { name: "PaymentDeclinedError", code: "PaymentDeclinedError", message: "declined" };

/** A failed first attempt of owner `owner-1`, as a caller reads it. */
const FAILED: OutboundCallState = {
  status: OutboundCallStatus.Failed,
  attempt: 1,
  attemptOwner: "owner-1",
};

/** The second attempt, claimed by `owner`. */
const nextOf = (attemptOwner: string) => ({ attempt: 2, attemptOwner });

const movedOnce: OutboundCallCase = {
  name: "markPending as read: true, the intent Pending at the next attempt and owner, under the caller's token; again from the same read: false, unchanged",
  run: async ({ first }) => {
    const key = keyOf(await leaseOf(first));
    await recorded(first, key);
    await first.calls.markFailed(key, FAILURE);

    const isMoved = await first.calls.markPending(key, FAILED, nextOf("owner-2"));
    const isMovedAgain = await first.calls.markPending(key, FAILED, nextOf("owner-3"));

    expect([isMoved, isMovedAgain]).toEqual([true, false]);
    expect(await first.calls.findByKey(key)).toMatchObject({
      status: OutboundCallStatus.Pending,
      attempt: 2,
      attemptOwner: "owner-2",
      token: 1,
    });
  },
};

const STALE_READS: readonly (readonly [string, OutboundCallState])[] = [
  ["another status", { ...FAILED, status: OutboundCallStatus.Pending }],
  ["another attempt", { ...FAILED, attempt: 2 }],
  ["another attempt owner", { ...FAILED, attemptOwner: "owner-9" }],
];

const staleReadRefused = ([what, expected]: (typeof STALE_READS)[number]): OutboundCallCase => ({
  name: `markPending from a read with ${what}: false, the intent unchanged`,
  run: async ({ first }) => {
    const key = keyOf(await leaseOf(first));
    await recorded(first, key);
    await first.calls.markFailed(key, FAILURE);

    const isMoved = await first.calls.markPending(key, expected, nextOf("owner-2"));

    expect(isMoved).toBe(false);
    expect(await first.calls.findByKey(key)).toMatchObject({
      status: OutboundCallStatus.Failed,
      attempt: 1,
      failure: FAILURE,
    });
  },
});

const noIntent: OutboundCallCase = {
  name: "markPending of a key never recorded: false, nothing recorded",
  run: async ({ first }) => {
    const key = keyOf(await leaseOf(first));

    expect(await first.calls.markPending(key, FAILED, nextOf("owner-2"))).toBe(false);
    expect(await first.calls.findByKey(key)).toBeUndefined();
  },
};

const racedOnce: OutboundCallCase = {
  name: "two instances move one intent from the same read at once: exactly one true",
  run: async ({ first, second }) => {
    const key = keyOf(await leaseOf(first));
    await recorded(first, key);
    await first.calls.markFailed(key, FAILURE);

    const moves = await Promise.all([
      first.calls.markPending(key, FAILED, nextOf("owner-a")),
      second.calls.markPending(key, FAILED, nextOf("owner-b")),
    ]);

    expect(moves.filter(Boolean)).toHaveLength(1);
    const owner = moves[0] ? "owner-a" : "owner-b";
    expect(await first.calls.findByKey(key)).toMatchObject({ attempt: 2, attemptOwner: owner });
  },
};

const newerHolderMoves: OutboundCallCase = {
  name: "the holder of a newer lease moves a pending intent read under the older token; the record then carries its token",
  run: async ({ clock, first, second }) => {
    const old = await leaseOf(first, "execution-1", seconds(30));
    await recorded(first, keyOf(old));
    await clock.advance(seconds(31));
    const key = keyOf(await leaseOf(second, "execution-1"));
    const read = { status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: "owner-1" };

    const isMoved = await second.calls.markPending(key, read, { attempt: 2, attemptOwner: "o-2" });

    expect(isMoved).toBe(true);
    expect(await second.calls.findByKey(key)).toMatchObject({ attemptOwner: "o-2", token: 2 });
  },
};

/** The new-attempt cases. */
export const outboundAttemptCases = (): ContractGroup<OutboundCallStores> => ({
  title: "new attempts",
  cases: [movedOnce, ...STALE_READS.map(staleReadRefused), noIntent, racedOnce, newerHolderMoves],
});
