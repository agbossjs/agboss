/**
 * #551 acceptance, #567 — what each way a lease ends tells the operator. The message says what is
 * known: the lease is over, this instance stops, the next take continues; another instance is named
 * only when a newer take was seen. Every way: a renewal refused, the holder's own expiry (frozen or
 * cut off), a reclaim after a remote-child wait, and a fenced write refused by the core's stores —
 * under an expired lease nobody took, a released one, one never taken, and after another
 * instance's take.
 */
import { describe, expect, it } from "vitest";
import {
  ExecutionLeaseLostError,
  leaseExpiredError,
  leaseTakenWhileYieldedError,
} from "../../src/app/lease-lost.js";
import { ExecutionFencedError } from "../../src/index.js";
import { seconds } from "../../src/units/index.js";
import {
  keyOf,
  leaseOf,
  type FencedEffectStores,
} from "../../src/testing/contracts/fenced-effect-data.js";
import { withTarget, type ContractTarget } from "../../src/testing/contracts/seam.js";
import {
  inMemoryFencedEffects,
  sqliteFencedEffects,
} from "../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryTarget, sqliteTarget } from "../infrastructure/contracts/store-kinds.js";

/** What a lone holder must never read: another instance as a fact. */
const ANOTHER_AS_FACT = /another instance (holds|continues|took it and)/u;
/** What every lease-over message says. */
const STOPS = /this instance stops, the (next take of the lease|holder of token \d+) continues/u;

describe("#551 / #567: the messages of the ways a lease ends, built", () => {
  it.each([
    ["a renewal refused", new ExecutionLeaseLostError("execution-1")],
    ["the holder's own expiry (frozen or cut off)", leaseExpiredError("execution-1")],
    ["a reclaim after a remote-child wait", leaseTakenWhileYieldedError("execution-1")],
    ["a fenced write, no token named", new ExecutionFencedError({ scopeKey: "a:b", token: 2 })],
    [
      "a fenced write, the same token seen",
      new ExecutionFencedError({ scopeKey: "a:b", token: 2, observedToken: 2 }),
    ],
    [
      "a fenced write, an older token seen",
      new ExecutionFencedError({ scopeKey: "a:b", token: 2, observedToken: 1 }),
    ],
  ])(
    "%s: the lease is over and the next take continues — no other instance as a fact",
    (_way, error) => {
      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(error.message).not.toMatch(ANOTHER_AS_FACT);
      expect(error.message).toMatch(STOPS);
    },
  );

  it("a fenced write after a newer take: the newer token, and its holder continuing", () => {
    const { message } = new ExecutionFencedError({ scopeKey: "a:b", token: 2, observedToken: 5 });

    expect(message).toMatch(/saw token 5 — a newer take of the lease/);
    expect(message).toMatch(/the holder of token 5 continues/);
    expect(message).not.toMatch(ANOTHER_AS_FACT);
  });
});

type AnyStores = FencedEffectStores<unknown>;

const TARGETS: readonly (readonly [string, () => ContractTarget<AnyStores>])[] = [
  ["in-memory", () => inMemoryTarget(inMemoryFencedEffects(false))],
  ["SQLite", () => sqliteTarget(sqliteFencedEffects)],
];

/** What a write of `stores` under `key` was refused with. */
const refusalOf = (stores: AnyStores, key: ReturnType<typeof keyOf>): Promise<unknown> =>
  stores.effects
    .saveResultIfAbsent(key, () => ({ charged: true }))
    .then(
      () => undefined,
      (error: unknown) => error,
    );

describe.each(TARGETS)(
  "#567 AC1: the core's %s fenced-effect store refusing a write",
  (_name, target) => {
    it("under an expired lease nobody took: the lease is over, no other instance named", async () => {
      await withTarget(target(), async ({ clock, first }) => {
        const key = keyOf(await leaseOf(first, "execution-1", seconds(30)));
        await clock.advance(seconds(31));

        const error = await refusalOf(first, key);

        expect(error).toBeInstanceOf(ExecutionFencedError);
        expect((error as Error).message).toMatch(/saw token 1, no newer take — the lease is over/);
        expect((error as Error).message).not.toMatch(ANOTHER_AS_FACT);
      })();
    });

    it("under a released lease: the lease is over, no other instance named", async () => {
      await withTarget(target(), async ({ first }) => {
        const lease = await leaseOf(first, "execution-1", seconds(30));
        await first.leases.release(lease);

        const error = await refusalOf(first, keyOf(lease));

        expect(error).toBeInstanceOf(ExecutionFencedError);
        expect((error as Error).message).toMatch(/the lease is over/);
        expect((error as Error).message).not.toMatch(ANOTHER_AS_FACT);
      })();
    });

    it("under a lease never taken: the lease is over, no other instance named", async () => {
      await withTarget(target(), async ({ first }) => {
        const key = {
          ...keyOf(await leaseOf(first, "execution-1", seconds(30))),
          leaseExecutionId: "execution-9",
          scopeKey: "default:execution-9",
        };

        const error = await refusalOf(first, key);

        expect(error).toBeInstanceOf(ExecutionFencedError);
        expect((error as Error).message).toMatch(/the lease is over/);
        expect((error as Error).message).not.toMatch(ANOTHER_AS_FACT);
      })();
    });

    it("after the other instance took the expired lease: the newer token, its holder continuing", async () => {
      await withTarget(target(), async ({ clock, first, second }) => {
        const key = keyOf(await leaseOf(first, "execution-1", seconds(30)));
        await clock.advance(seconds(31));
        await leaseOf(second, "execution-1", seconds(30));

        const error = await refusalOf(first, key);

        expect(error).toBeInstanceOf(ExecutionFencedError);
        expect((error as Error).message).toMatch(/saw token 2 — a newer take of the lease/);
      })();
    });
  },
);
