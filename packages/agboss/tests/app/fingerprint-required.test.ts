/**
 * #825 AC1, AC2 — a fenced effect under a business key says what it does. Two effects under one
 * business key that do other work — a charge and a refund of `order:42` — are a conflict, never a
 * replay; `withoutFingerprint: true` replays on purpose; a key without either is a compile error and,
 * for a JavaScript caller or a cast, `IdempotencyError.FingerprintRequired` before anything runs (before #825 the
 * refund silently replayed the charge). An object literal is not an `EffectKey`: only `effectKeyOf`
 * makes one for an application, `effectKeyForTesting` for a store's tests.
 */
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  FencedEffectRepository,
  IdempotencyRunStatus,
  Idempotency,
  InMemoryFencedEffectRepository,
  type ExecutionContext,
} from "../../src/index.js";
import {
  effectKeyOf,
  FingerprintProblem,
  type EffectKey,
  type OutboundCallKey,
  type EffectKeyFields,
} from "../../src/stores/index.js";
import { testWith } from "../../src/testing/index.js";
import { effectKeyForTesting } from "../../src/testing/contracts/index.js";
import { execute } from "../helpers/flow.js";
import {
  BOOKINGS,
  books,
  FingerprintApplication,
  resetBooks,
} from "./fixtures/rotation/fingerprint.application.js";

const test = testWith(FingerprintApplication);
const ORDER = { orderId: "42", amountUsd: 10 };

beforeEach(() => {
  resetBooks();
});

describe("#825 AC1: two effects under one business key with other work", () => {
  test("a charge, then a refund of the same order: IdempotencyError.KeyConflict — the refund never replays the charge", async ({
    app,
  }) => {
    await execute(app, BOOKINGS.charge.start, ORDER);

    await expect(execute(app, BOOKINGS.refund.start, ORDER)).rejects.toFailWith(
      IdempotencyError.KeyConflict,
      { effect: "book" },
    );
    expect(books.ran).toEqual(["charge"]);
    expect(books.statuses).toEqual([IdempotencyRunStatus.Ran]);
  });

  test("the same work again replays it", async ({ app }) => {
    await execute(app, BOOKINGS.charge.start, ORDER);
    await execute(app, BOOKINGS.charge.start, ORDER);

    expect(books.ran).toEqual(["charge"]);
    expect(books.statuses).toEqual([IdempotencyRunStatus.Ran, IdempotencyRunStatus.Replayed]);
  });

  test("withoutFingerprint: true replays on purpose, whatever the parameters", async ({ app }) => {
    await execute(app, BOOKINGS.event.start, ORDER);
    await execute(app, BOOKINGS.event.start, { ...ORDER, amountUsd: 12 });

    expect(books.ran).toEqual(["event-10"]);
    expect(books.statuses).toEqual([IdempotencyRunStatus.Ran, IdempotencyRunStatus.Replayed]);
  });

  test("a key that says neither — a JavaScript caller, a cast: IdempotencyError.FingerprintRequired, nothing ran, twice", async ({
    app,
  }) => {
    for (const booking of [BOOKINGS["unsaid-charge"], BOOKINGS["unsaid-refund"]])
      await expect(execute(app, booking.start, ORDER)).rejects.toFailWith(
        IdempotencyError.FingerprintRequired,
        { effect: "book", reason: FingerprintProblem.Missing },
      );

    expect(books.ran).toEqual([]);
    expect(books.statuses).toEqual([]);
  });
});

/** A store whose transaction a refused key never reaches. */
class UnreachedStore extends FencedEffectRepository<void> {
  ping(): Promise<void> {
    return Promise.resolve();
  }

  protected runInTransaction(): Promise<never> {
    return Promise.reject(new Error("the transaction was reached"));
  }

  deleteByStoredAtBefore(): Promise<void> {
    return Promise.resolve();
  }
}

describe("#825 AC1: the fingerprint decision at the store's entry", () => {
  const KEY = {
    scopeKey: "default:execution-1",
    tenantId: "default",
    leaseExecutionId: "execution-1",
    token: 1,
    idempotencyKey: "execution-1:book-action:1",
    name: "book",
    businessKey: "order:42",
  };

  it.each([
    ["neither", KEY, FingerprintProblem.Missing],
    [
      "both a fingerprint and the policy",
      { ...KEY, fingerprint: "f", withoutFingerprint: true as const },
      FingerprintProblem.Contradictory,
    ],
    [
      "a policy that is not one",
      { ...KEY, withoutFingerprint: "always" as never },
      FingerprintProblem.Contradictory,
    ],
  ])("%s: refused before any transaction, with its code", async (_what, fields, reason) => {
    const store = new UnreachedStore();
    let ran = 0;

    const refused = store.runOnce(effectKeyForTesting(fields), () => {
      ran += 1;
      return {};
    });

    await expect(refused).rejects.toMatchObject({
      name: "IdempotencyError.FingerprintRequired",
      code: "idempotency.fingerprint-required",
      effect: "book",
      reason,
    });
    expect(ran).toBe(0);
  });

  it("a copy of a key the framework made — a cast, or a JavaScript caller — is refused at run time, nothing ran", async () => {
    const store = new UnreachedStore();
    const made = effectKeyForTesting(KEY, { fingerprint: "f" });
    let ran = 0;

    const fields: EffectKeyFields = made;
    // @ts-expect-error — a copy drops the key's mark: it does not compile (a JavaScript caller's runs)
    const refused = store.runOnce({ ...fields, token: made.token + 1 }, () => {
      ran += 1;
      return {};
    });

    await expect(refused).rejects.toThrow(/make it with effectKeyOf/u);
    expect(ran).toBe(0);
  });

  it("no key at all from JavaScript is refused as an unissued one — a rejection, never a throw", async () => {
    const store = new UnreachedStore();
    for (const none of [null, undefined, "a key", 5] as unknown[]) {
      const refused = store.runOnce(none as EffectKey, () => ({}));

      await expect(refused).rejects.toThrow(/make it with effectKeyOf/u);
    }
  });

  it("a step's key, or one with a fingerprint or the policy, is let through to the store", () => {
    expect(() => effectKeyForTesting(KEY, { fingerprint: "" })).not.toThrow();
    expect(IdempotencyError.FingerprintRequired.code).toBe("idempotency.fingerprint-required");
  });
});

/** What a spread of `T` is, by type: its public members — a key's private mark is not one. */
type SpreadOf<T> = { [K in keyof T]: T[K] };

describe("#825 AC1, AC2: the compile-time contract", () => {
  it("a fenced effect under a business key without a fingerprint decision does not compile; a call takes it", () => {
    const executionContext = {} as ExecutionContext;
    const store = {} as InMemoryFencedEffectRepository;
    const idempotency = {} as Idempotency;
    const unsaid = () => effectKeyOf(executionContext, "book", { businessKey: "order:42" });
    const typed = () =>
      effectKeyOf(executionContext, "book", { businessKey: "order:42", fingerprint: { a: 1 } });
    const none = () =>
      effectKeyOf(executionContext, "book", {
        businessKey: "order:42",
        withoutFingerprint: true,
      });

    expectTypeOf(unsaid).returns.toEqualTypeOf<OutboundCallKey>();
    expectTypeOf(typed).returns.toEqualTypeOf<EffectKey>();
    expectTypeOf(none).returns.toEqualTypeOf<EffectKey>();
    // @ts-expect-error — a fenced effect needs a fingerprint or withoutFingerprint: true (#825)
    const refused = () => store.runOnce(unsaid(), () => ({}));
    const sent = () => idempotency.sendOnce({ name: "book", key: "order:42" } as never);
    const bothOptions = {
      businessKey: "k",
      fingerprint: 1,
      withoutFingerprint: true,
    };
    // @ts-expect-error — a fingerprint and the policy at once does not compile
    const both = () => effectKeyOf(executionContext, "b", bothOptions);
    const notJsonOptions = { businessKey: "k", fingerprint: () => 1 };
    // @ts-expect-error — a fingerprint is plain JSON: a function is not
    const notJson = () => effectKeyOf(executionContext, "b", notJsonOptions);
    expect([refused, sent, both, notJson]).toHaveLength(4);
  });

  it("an object literal is not an EffectKey: forging one does not compile", () => {
    const key = effectKeyForTesting({
      scopeKey: "default:execution-1",
      tenantId: "default",
      leaseExecutionId: "execution-1",
      token: 1,
      idempotencyKey: "i",
      name: "charge",
    });
    // @ts-expect-error — a literal is no EffectKey (#825: branded)
    const literal: EffectKey = { ...KEY_FIELDS };
    // @ts-expect-error — nor a forged copy
    const forged: EffectKey = {
      scopeKey: key.scopeKey,
      tenantId: key.tenantId,
      leaseExecutionId: key.leaseExecutionId,
      token: key.token + 1,
      idempotencyKey: key.idempotencyKey,
      name: key.name,
    };

    // a spread of a key is its fields without the mark: by type, every spread forgery below
    expectTypeOf<SpreadOf<EffectKey>>().not.toExtend<EffectKey>();
    expectTypeOf<SpreadOf<OutboundCallKey>>().not.toExtend<EffectKey>();
    expectTypeOf<SpreadOf<OutboundCallKey>>().not.toExtend<OutboundCallKey>();
    const fields: EffectKeyFields = key;
    // @ts-expect-error — nor a spread copy under another token
    const spreadToken: EffectKey = { ...fields, token: key.token + 1 };
    // @ts-expect-error — nor one with a fingerprint of the caller's own
    const spreadFingerprint: EffectKey = { ...fields, fingerprint: "constant" };
    // @ts-expect-error — nor a call's key turned into a fenced effect's that says it has no fingerprint
    const spreadPolicy: EffectKey = { ...fields, withoutFingerprint: true };
    // nor a call's key passed as a fenced effect's, nor the other way round
    expectTypeOf<OutboundCallKey>().not.toExtend<EffectKey>();
    expectTypeOf<EffectKey>().not.toExtend<OutboundCallKey>();

    expect([literal, forged, spreadToken, spreadFingerprint, spreadPolicy]).toHaveLength(5);
    expect(Object.isFrozen(key)).toBe(true);
  });
});

const KEY_FIELDS = {
  scopeKey: "default:execution-1",
  tenantId: "default",
  leaseExecutionId: "execution-1",
  token: 1,
  idempotencyKey: "i",
  name: "charge",
};
