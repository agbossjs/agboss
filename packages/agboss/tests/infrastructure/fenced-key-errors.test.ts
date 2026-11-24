/**
 * #825 — the fingerprint decision's errors and helpers on their own: each error's name, code, text
 * and details; the options' facts (both, or a policy that is not one, refused); the decision checked
 * where the stores run it; a fingerprint's own error passing as it is; the previous key's match.
 */
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { describe, expect, it } from "vitest";
import { runInFrame } from "../../src/flow/context/frame.js";
import {
  assertFingerprintDecided,
  fingerprintFactsOf,
  fingerprintsOf,
  isKeyFingerprint,
} from "../../src/infrastructure/fenced-effect-fingerprint.js";
import {
  FingerprintProblem,
  fingerprintNotJson,
  fingerprintRequired,
  secretKeyMissing,
} from "../../src/infrastructure/idempotency-errors.js";
import { testFrame } from "../helpers/frame.js";

const TAIL =
  "— idempotency.runOnce({ name, key, fingerprint: { …what the work does }, … }): nothing ran";

describe("#825: the fingerprint's errors", () => {
  it("IdempotencyError.FingerprintRequired, missing: its name, code, text and details", () => {
    const error = fingerprintRequired({
      effect: "charge",
      reason: FingerprintProblem.Missing,
    });

    expect(error).toMatchObject({
      name: "IdempotencyError.FingerprintRequired",
      code: "idempotency.fingerprint-required",
      effect: "charge",
      reason: "missing",
      details: { effect: "charge", reason: "missing" },
      message: `the effect "charge" under a key names neither a fingerprint nor withoutFingerprint: true ${TAIL}`,
    });
  });

  it("IdempotencyError.FingerprintRequired, contradictory: its own text", () => {
    const error = fingerprintRequired({
      effect: "refund",
      reason: FingerprintProblem.Contradictory,
    });

    expect(error).toMatchObject({
      reason: "contradictory",
      details: { effect: "refund", reason: "contradictory" },
      message: `the effect "refund" under a key names a fingerprint and withoutFingerprint: true, or a withoutFingerprint that is not true ${TAIL}`,
    });
  });

  it("IdempotencyError.SecretKeyMissing and IdempotencyError.FingerprintNotJson: names, codes, texts, details", () => {
    expect(secretKeyMissing({ effect: "charge" })).toMatchObject({
      name: "IdempotencyError.SecretKeyMissing",
      code: "idempotency.secret-key-missing",
      effect: "charge",
      details: { effect: "charge" },
      message:
        '"charge" is under a key, whose fingerprint is keyed by the application\'s idempotency secret — none here: name idempotencySecret in @DatabaseStorage and make the key in a step',
    });
    expect(fingerprintNotJson({ effect: "charge", path: "$.at", reason: "a Date" })).toMatchObject({
      name: "IdempotencyError.FingerprintNotJson",
      code: "idempotency.fingerprint-not-json",
      effect: "charge",
      path: "$.at",
      details: { effect: "charge", path: "$.at" },
      message:
        'the fingerprint of "charge" is not plain JSON at $.at: a Date — fingerprint: { …the plain fields of what the work does }, never a DTO instance, a Date or a function',
    });
  });
});

describe("#825: what a business key's options say", () => {
  const facts = (options: object) => () =>
    fingerprintFactsOf("charge", { businessKey: "order:42", ...options });

  it("the policy None alone; nothing (a call's key)", () => {
    expect(facts({ withoutFingerprint: true })()).toStrictEqual({
      withoutFingerprint: true,
    });
    expect(facts({})()).toStrictEqual({});
  });

  it("both, or a policy that is not one — with a fingerprint or without: Contradictory", () => {
    for (const options of [
      { fingerprint: { amount: 1 }, withoutFingerprint: true },
      { withoutFingerprint: "none-ish" },
      { fingerprint: { amount: 1 }, withoutFingerprint: "none-ish" },
    ])
      expect(facts(options)).toThrow(
        expect.objectContaining({
          name: "IdempotencyError.FingerprintRequired",
          reason: "contradictory",
        }),
      );
  });

  it("the decision as the stores check it: thrown when missing, nothing when said", () => {
    const key = { name: "charge", businessKey: "order:42" };

    expect(() => {
      assertFingerprintDecided(key);
    }).toThrow(IdempotencyError.FingerprintRequired);
    expect(() => {
      assertFingerprintDecided({ ...key, fingerprint: "f" });
    }).not.toThrow();
    expect(() => {
      assertFingerprintDecided({ name: "charge" });
    }).not.toThrow();
  });
});

describe("#825: a fingerprint's own failure, and the previous key's match", () => {
  it("a value whose getter throws passes its error as it is — never as not JSON", async () => {
    const failure = new Error("the getter failed");
    const value = {
      get amount(): number {
        throw failure;
      },
    };
    const frame = testFrame();
    const keyed = {
      ...frame,
      execution: { ...frame.execution, fingerprintKeys: { current: "k" } },
    };

    await expect(
      runInFrame(keyed, () => Promise.resolve().then(() => fingerprintsOf(value, "charge"))),
    ).rejects.toBe(failure);
  });

  it("the previous key's fingerprint matches a stored one only", () => {
    expect(isKeyFingerprint({ fingerprint: "now" }, undefined)).toBe(false);
    expect(isKeyFingerprint({ fingerprint: undefined }, null)).toBe(true);
    expect(isKeyFingerprint({ fingerprint: "now", previousFingerprint: "then" }, "then")).toBe(
      true,
    );
    expect(isKeyFingerprint({ fingerprint: "now", previousFingerprint: "then" }, undefined)).toBe(
      false,
    );
    expect(isKeyFingerprint({ fingerprint: "now" }, "then")).toBe(false);
  });
});

describe("#906 AC4: IdempotencyError.FingerprintRequired({ effect, reason, cause })", () => {
  it("AC4: the option key is the field — `effect` — and no `name` option shadows Error.name", () => {
    const cause = new Error("the store's check");

    const error = fingerprintRequired({
      effect: "refund",
      reason: FingerprintProblem.Missing,
      cause,
    });

    expect(error).toMatchObject({ effect: "refund", reason: "missing", cause });
    expect(error.name).toBe("IdempotencyError.FingerprintRequired");
    expect(error.details).toEqual({ effect: "refund", reason: "missing" });
  });

  it("AC4: a refusal from a key's options carries the effect's name as `.effect`", () => {
    const refused = (): unknown => {
      try {
        fingerprintFactsOf("refund", {
          businessKey: "order:42",
          fingerprint: { amount: 1 },
          withoutFingerprint: true,
        } as never);
      } catch (error) {
        return error;
      }
      return undefined;
    };

    expect(refused()).toMatchObject({ effect: "refund", reason: "contradictory" });
  });
});
