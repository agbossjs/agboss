/**
 * #825 — the fingerprint decision's errors and helpers on their own: each error's name, code, text
 * and details; the options' facts (both, or a policy that is not one, refused); the decision checked
 * where the stores run it; a fingerprint's own error passing as it is; the previous key's match.
 */
import { describe, expect, it } from "vitest";
import { runInFrame } from "../../src/flow/context/frame.js";
import {
  FingerprintNotJsonError,
  FingerprintPolicy,
  FingerprintRequiredError,
  IdempotencyKeyMissingError,
} from "../../src/index.js";
import {
  assertFingerprintDecided,
  fingerprintFactsOf,
  fingerprintsOf,
  FingerprintProblem,
  isKeyFingerprint,
} from "../../src/infrastructure/fenced-effect-fingerprint.js";
import { testFrame } from "../helpers/frame.js";

const TAIL =
  "— effectKeyOf(executionContext, name, { businessKey, fingerprint: { …what the work does } }): nothing ran";

describe("#825: the fingerprint's errors", () => {
  it("FingerprintRequiredError, missing: its name, code, text and details", () => {
    const error = new FingerprintRequiredError({
      name: "charge",
      reason: FingerprintProblem.Missing,
    });

    expect(error).toMatchObject({
      name: "FingerprintRequiredError",
      code: "fenced-effect.fingerprint-required",
      effect: "charge",
      reason: "missing",
      details: { effect: "charge", reason: "missing" },
      message: `the fenced effect "charge" under a business key names neither a fingerprint nor fingerprintPolicy: FingerprintPolicy.None ${TAIL}`,
    });
  });

  it("FingerprintRequiredError, contradictory: its own text", () => {
    const error = new FingerprintRequiredError({
      name: "refund",
      reason: FingerprintProblem.Contradictory,
    });

    expect(error).toMatchObject({
      reason: "contradictory",
      details: { effect: "refund", reason: "contradictory" },
      message: `the fenced effect "refund" under a business key names a fingerprint and a fingerprintPolicy, or a policy that is not FingerprintPolicy.None ${TAIL}`,
    });
  });

  it("IdempotencyKeyMissingError and FingerprintNotJsonError: names, codes, texts, details", () => {
    expect(new IdempotencyKeyMissingError("charge")).toMatchObject({
      name: "IdempotencyKeyMissingError",
      code: "fenced-effect.idempotency-key-missing",
      effect: "charge",
      details: { effect: "charge" },
      message:
        '"charge" is under a business key, whose fingerprint is keyed by the application\'s idempotency key — none here: name a Secret field in @Application({ idempotencyKeyField }) and make the key in a step',
    });
    expect(new FingerprintNotJsonError("charge", { path: "$.at", reason: "a Date" })).toMatchObject(
      {
        name: "FingerprintNotJsonError",
        code: "fenced-effect.fingerprint-not-json",
        effect: "charge",
        path: "$.at",
        details: { effect: "charge", path: "$.at" },
        message:
          'the fingerprint of "charge" is not plain JSON at $.at: a Date — fingerprint: { …the plain fields of what the work does }, never a DTO instance, a Date or a function',
      },
    );
  });
});

describe("#825: what a business key's options say", () => {
  const facts = (options: object) => () =>
    fingerprintFactsOf("charge", { businessKey: "order:42", ...options });

  it("the policy None alone; nothing (a call's key)", () => {
    expect(facts({ fingerprintPolicy: FingerprintPolicy.None })()).toStrictEqual({
      fingerprintPolicy: FingerprintPolicy.None,
    });
    expect(facts({})()).toStrictEqual({});
  });

  it("both, or a policy that is not one — with a fingerprint or without: Contradictory", () => {
    for (const options of [
      { fingerprint: { amount: 1 }, fingerprintPolicy: FingerprintPolicy.None },
      { fingerprintPolicy: "none-ish" },
      { fingerprint: { amount: 1 }, fingerprintPolicy: "none-ish" },
    ])
      expect(facts(options)).toThrow(
        expect.objectContaining({ name: "FingerprintRequiredError", reason: "contradictory" }),
      );
  });

  it("the decision as the stores check it: thrown when missing, nothing when said", () => {
    const key = { name: "charge", businessKey: "order:42" };

    expect(() => {
      assertFingerprintDecided(key);
    }).toThrow(FingerprintRequiredError);
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
