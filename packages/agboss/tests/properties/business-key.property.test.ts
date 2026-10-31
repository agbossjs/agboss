/**
 * #533 item 2, AC2: the business-key rules as properties (#508, #538) — a fingerprint is the
 * request's canonical JSON (the order of keys never matters, two requests that differ never share
 * one), a key's identity and the key sent with a call are one-to-one with their parts, and the
 * fenced effect under a business key gives, for any sequence of calls of two executions: `Ran` the
 * first time, `Replayed` with the first result and the step that made it for the same fingerprint,
 * `IdempotencyKeyConflictError` for another, and `Joined` for a call of the same instance in flight.
 * Seeds are logged (FC_SEED replays a run).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scopeKeyOf } from "../../src/app/lease-lost.js";
import { callKeyOf } from "../../src/app/outbound-call-business.js";
import { keyTextRuleOf } from "../../src/core/errors.js";
import {
  fencedKeyIdentityOf,
  fingerprintOf,
  IdempotencyKeyConflictError,
} from "../../src/infrastructure/fenced-effect-key.js";
import {
  FencedEffectStatus,
  type FencedEffectOutcome,
  type FencedEffectKey,
} from "../../src/infrastructure/fenced-effect.repository.js";
import { stableJson } from "../../src/terns/versions.js";
import { seconds } from "../../src/units/index.js";
import { seededProperties } from "../helpers/property-seed.js";
import { inMemoryFencedEffects } from "../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryTarget } from "../infrastructure/contracts/store-kinds.js";
import { instancesOn } from "./fencing-model.js";
import { rewritingKeys, stepOnly } from "../fixtures/contracts/naive-guarantees.js";

const seed = seededProperties("business-key.property.test.ts");

/** A key's text the rules accept (#538). */
const keyText = fc
  .string({ minLength: 1, maxLength: 12, unit: "grapheme" })
  .filter((text) => keyTextRuleOf(text) === undefined);
const name = fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/u).filter((text) => !text.startsWith("."));

/** A key of `tenantId`, `businessKey` and `effect` (the rest fixed). */
const keyWith = (tenantId: string, businessKey: string, effect: string): FencedEffectKey => ({
  scopeKey: scopeKeyOf(tenantId, "tree-1"),
  tenantId,
  leaseExecutionId: "tree-1",
  token: 1,
  idempotencyKey: "tree-1:charge-action:1",
  name: effect,
  businessKey,
});

/** The keys of `value` in another order. */
function shuffled(value: unknown, order: number): unknown {
  if (Array.isArray(value)) return value.map((item) => shuffled(item, order));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).map(([key, item]) => [key, shuffled(item, order)] as const);
  const rotated =
    entries.length === 0
      ? entries
      : [...entries.slice(order % entries.length), ...entries.slice(0, order % entries.length)];
  return Object.fromEntries(rotated.reverse());
}

describe(`#533 AC2: the business-key rules (seed ${String(seed)})`, () => {
  it("a fingerprint does not depend on the order of an object's keys", () => {
    expect(() => {
      fc.assert(
        fc.property(
          fc.jsonValue(),
          fc.nat(5),
          (value, order) => fingerprintOf(shuffled(value, order)) === fingerprintOf(value),
        ),
        { numRuns: 500 },
      );
    }).not.toThrow();
  });

  it("two requests whose canonical JSON differs never share a fingerprint", () => {
    expect(() => {
      fc.assert(
        fc.property(
          fc.jsonValue(),
          fc.jsonValue(),
          (one, other) =>
            stableJson(one) === stableJson(other) || fingerprintOf(one) !== fingerprintOf(other),
        ),
        { numRuns: 500 },
      );
    }).not.toThrow();
  });

  it("a key's identity and the key sent with its call are one-to-one with the tenant, business key and name", () => {
    const triple = fc.tuple(keyText, keyText, name);
    expect(() => {
      fc.assert(
        fc.property(triple, triple, ([t1, b1, n1], [t2, b2, n2]) => {
          const isSame = t1 === t2 && b1 === b2 && n1 === n2;
          const [one, other] = [keyWith(t1, b1, n1), keyWith(t2, b2, n2)];
          return (
            (fencedKeyIdentityOf(one) === fencedKeyIdentityOf(other)) === isSame &&
            (callKeyOf(one) === callKeyOf(other)) === isSame
          );
        }),
        { numRuns: 1000 },
      );
    }).not.toThrow();
  });
});

/** One call of the sequence: which execution, which request, whether a second copy is in flight. */
interface BusinessCall {
  readonly execution: 1 | 2;
  readonly request: "a" | "b";
  readonly isDoubled: boolean;
}

const businessCall: fc.Arbitrary<BusinessCall> = fc.record({
  execution: fc.constantFrom(1 as const, 2 as const),
  request: fc.constantFrom("a" as const, "b" as const),
  isDoubled: fc.boolean(),
});

/** What the model says a call gives, after `first` (the first call that ran, if one did). */
function expectedOf(call: BusinessCall, first: BusinessCall | undefined): string {
  if (first === undefined) return call.isDoubled ? "ran+joined" : "ran";
  // another fingerprint is never joined: each copy reaches the store and is refused
  if (first.request !== call.request) return call.isDoubled ? "conflict+conflict" : "conflict";
  const from = first.execution === call.execution ? "" : `@tree-${String(first.execution)}`;
  return call.isDoubled ? `replayed${from}+joined` : `replayed${from}`;
}

/** Runs `calls` on the in-memory fenced-effect store; each one's outcome as the model names it. */
async function outcomesOf(
  calls: readonly BusinessCall[],
  isStepOnly = false,
): Promise<{ outcomes: string[]; expected: string[] }> {
  const target = inMemoryTarget((seam) => {
    const stores = inMemoryFencedEffects(false)(seam);
    if (!isStepOnly) return stores;
    return { ...stores, effects: rewritingKeys(stores.effects, seam.database, stepOnly) };
  });
  const { stores } = await instancesOn(target);
  const [one, two] = stores;
  if (one === undefined || two === undefined) throw new Error("two instances expected");
  const leases = [
    await one.leases.acquire("default", "tree-1", seconds(3600)),
    await two.leases.acquire("default", "tree-2", seconds(3600)),
  ];
  const outcomes: string[] = [];
  const expected: string[] = [];
  let first: BusinessCall | undefined;
  for (const call of calls) {
    const stores = call.execution === 1 ? one : two;
    const lease = leases[call.execution - 1];
    if (lease === undefined) throw new Error("no lease");
    const tree = `tree-${String(call.execution)}`;
    const key: FencedEffectKey = {
      ...keyWith("default", "order:1", "charge"),
      scopeKey: scopeKeyOf("default", tree),
      leaseExecutionId: tree,
      token: lease.leaseEpoch,
      idempotencyKey: `${tree}:charge-action:1`,
      fingerprint: fingerprintOf({ request: call.request }),
      origin: { executionId: tree, nodeId: "charge-action", visitNumber: 1 },
    };
    expected.push(expectedOf(call, first));
    const write = (): Promise<FencedEffectOutcome<{ request: string }>> =>
      stores.effects.saveResultIfAbsent(key, (transaction) => {
        void stores.rows.insert(transaction, `${tree}:${call.request}`);
        return { request: call.request };
      });
    const settled = await Promise.allSettled(call.isDoubled ? [write(), write()] : [write()]);
    outcomes.push(settled.map((result) => outcomeText(result)).join("+"));
    first ??= settled.some((result) => result.status === "fulfilled") ? call : undefined;
  }
  return { outcomes, expected };
}

/** A settled call as the model names it. */
function outcomeText(
  result: PromiseSettledResult<{
    status: FencedEffectStatus;
    replayedFrom?: { executionId: string };
  }>,
): string {
  if (result.status === "rejected")
    return result.reason instanceof IdempotencyKeyConflictError
      ? "conflict"
      : String(result.reason);
  const { status, replayedFrom } = result.value;
  if (status === FencedEffectStatus.Replayed)
    return replayedFrom === undefined ? "replayed" : `replayed@${replayedFrom.executionId}`;
  return status;
}

describe(`#533 AC2: a business key's replays, joins and conflicts (seed ${String(seed)})`, () => {
  it("any sequence of calls of two executions: ran, replayed with its origin, joined, or a conflict — as the model says", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(businessCall, { minLength: 1, maxLength: 12 }), async (calls) => {
        const { outcomes, expected } = await outcomesOf(calls);
        expect(outcomes).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  }, 60_000);

  it("bites: a store keyed by the step only runs the second execution's charge again", async () => {
    const result = await fc.check(
      fc.asyncProperty(fc.array(businessCall, { minLength: 1, maxLength: 12 }), async (calls) => {
        const { outcomes, expected } = await outcomesOf(calls, true);
        return JSON.stringify(outcomes) === JSON.stringify(expected);
      }),
      { seed: 533, numRuns: 300 },
    );
    expect(result.failed).toBe(true);
    expect(result.counterexample?.[0].length).toBeLessThanOrEqual(3);
  }, 60_000);
});
