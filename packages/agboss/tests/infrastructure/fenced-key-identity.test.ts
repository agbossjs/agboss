/**
 * #626 — the business-key identity's own rules, each found by a mutant that lived: the
 * fingerprint and the handle are derived under their labels (known-answer values), outside a step
 * too; a key without a handle has none at all; a replay names the step that made the effect only
 * when it is another step; an operator's read shows a business key by its handle, or by its name
 * alone; the conflict and the key errors say what they say.
 */
import { describe, expect, it } from "vitest";
import { runInFrame, type FrameSpec } from "../../src/flow/context/frame.js";
import {
  BUSINESS_KEY_HANDLE_LABEL,
  businessKeyHashOf,
  FINGERPRINT_LABEL,
  fencedEffectKeyOf,
  fingerprintOf,
  IdempotencyKeyConflictError,
  InvalidBusinessKeyError,
  InvalidFencedEffectNameError,
  replayedFromOf,
  shownCallOf,
} from "../../src/infrastructure/fenced-effect-key.js";
import type { FencedEffectKey } from "../../src/infrastructure/fenced-effect.repository.js";
import type { OutboundCallRecord } from "../../src/infrastructure/outbound-call.repository.js";
import { keyedDigestOf } from "../../src/pii/tokens.js";
import { stableJson, versionOf } from "../../src/terns/versions.js";
import { testFrame } from "../helpers/frame.js";

/** A step's frame with the execution's keys as given. */
const frameWith = (keys: { correlationKey?: string; fingerprintKey?: string }): FrameSpec => {
  const frame = testFrame();
  return { ...frame, execution: { ...frame.execution, ...keys } };
};

const inFrame = <TResult>(frame: FrameSpec, work: () => TResult): Promise<TResult> =>
  runInFrame(frame, () => Promise.resolve(work()));

const REQUEST = { amount: 10, currency: "EUR" };
const TEXT = `fingerprint\u0000${stableJson(REQUEST)}`;

/** A business key's step key, made by `executionId`'s step `nodeId` at visit `visitNumber`. */
const keyMadeBy = (origin: { executionId: string; nodeId: string; visitNumber: number }) =>
  ({
    scopeKey: "default:execution-1",
    tenantId: "default",
    leaseExecutionId: "execution-1",
    token: 1,
    idempotencyKey: "execution-1:charge-action:1",
    name: "charge",
    businessKey: "order:42",
    origin,
  }) satisfies FencedEffectKey;

const ORIGIN = { executionId: "execution-1", nodeId: "charge-action", visitNumber: 1 };

describe("#626: the fingerprint and the handle, under their labels", () => {
  it("the labels are the ones the Wiki names", () => {
    expect(FINGERPRINT_LABEL).toBe("agboss/fingerprint/v1");
    expect(BUSINESS_KEY_HANDLE_LABEL).toBe("agboss/business-key-handle/v1");
  });

  it("outside a step a fingerprint is the labelled SHA-256 of the canonical JSON", () => {
    expect(fingerprintOf(REQUEST)).toBe(versionOf(`agboss/fingerprint/v1\u0000${TEXT}`));
    expect(fingerprintOf({ currency: "EUR", amount: 10 })).toBe(fingerprintOf(REQUEST));
  });

  it("in a step with the application's key it is an HMAC under the label's subkey", async () => {
    const fingerprint = await inFrame(frameWith({ fingerprintKey: "app-key" }), () =>
      fingerprintOf(REQUEST),
    );

    expect(fingerprint).toBe(
      keyedDigestOf(keyedDigestOf("app-key", "agboss/fingerprint/v1"), TEXT),
    );
  });

  it("a handle is 12 hex of an HMAC under the PII key's labelled subkey; none outside a step or without a key", async () => {
    const handle = await inFrame(frameWith({ correlationKey: "pii-key" }), () =>
      businessKeyHashOf("order:42"),
    );
    const subkey = keyedDigestOf("pii-key", "agboss/business-key-handle/v1");

    expect(handle).toBe(keyedDigestOf(subkey, "business-key\u0000order:42").slice(0, 12));
    expect(businessKeyHashOf("order:42")).toBeUndefined();
    expect(await inFrame(frameWith({}), () => businessKeyHashOf("order:42"))).toBeUndefined();
  });

  it("a business key's key without a handle has no businessKeyHash at all", async () => {
    const context = {
      executionId: "execution-1",
      step: {
        nodeId: "charge-action",
        visitNumber: 1,
        idempotencyKey: "execution-1:charge-action:1",
      },
      fence: {
        scopeKey: "default:execution-1",
        tenantId: "default",
        leaseExecutionId: "execution-1",
        token: 1,
      },
    } as never;

    const key = await inFrame(frameWith({}), () =>
      fencedEffectKeyOf(context, "charge", { businessKey: "order:42" }),
    );

    expect(Object.keys(key)).not.toContain("businessKeyHash");
    expect(key.businessKey).toBe("order:42");
  });
});

describe("#626: a replay names another step, never its own", () => {
  it.each([
    ["another execution", { ...ORIGIN, executionId: "execution-2" }],
    ["another node", { ...ORIGIN, nodeId: "refund-action" }],
    ["another visit", { ...ORIGIN, visitNumber: 2 }],
  ])("a stored step of %s is named", (_, stored) => {
    expect(replayedFromOf(keyMadeBy(ORIGIN), { origin: stored })).toEqual(stored);
  });

  it("the same step is not named; a key with no step of its own is told the stored one", () => {
    const key = keyMadeBy(ORIGIN);
    const { origin: _origin, ...noStep } = key;

    expect(replayedFromOf(key, { origin: ORIGIN })).toBeUndefined();
    expect(replayedFromOf(noStep, { origin: ORIGIN })).toEqual(ORIGIN);
  });
});

describe("#626: what an operator's read shows of a business key", () => {
  const record = {
    name: "charge",
    businessKey: "order:42",
    fingerprint: "f",
    idempotencyKey: "default:order%3A42:charge",
  } as OutboundCallRecord;

  it("the handle and the name with a handle, the name alone without one; never the key or the fingerprint", () => {
    expect(shownCallOf({ ...record, businessKeyHash: "a1b2c3d4e5f6" }).idempotencyKey).toBe(
      "business-key:a1b2c3d4e5f6:charge",
    );
    expect(shownCallOf(record).idempotencyKey).toBe("business-key:charge");
    expect(shownCallOf(record)).not.toHaveProperty("businessKey");
    expect(shownCallOf(record)).not.toHaveProperty("fingerprint");
  });
});

describe("#626: the key errors", () => {
  it("IdempotencyKeyConflictError: its name, code and message, with and without a handle", () => {
    const withHandle = new IdempotencyKeyConflictError({ name: "charge", businessKeyHash: "a1b2" });
    const without = new IdempotencyKeyConflictError({ name: "charge" });

    expect(withHandle).toMatchObject({
      name: "IdempotencyKeyConflictError",
      code: "fenced-effect.key-conflict",
      message:
        '"charge" was already made under the same business key (handle a1b2) with other parameters: refused, nothing ran',
    });
    expect(without.message).toBe(
      '"charge" was already made under the same business key with other parameters: refused, nothing ran',
    );
    expect(Object.keys(without)).not.toContain("businessKeyHash");
  });

  it("InvalidFencedEffectNameError and InvalidBusinessKeyError are named and coded", () => {
    expect(new InvalidFencedEffectNameError(0)).toMatchObject({
      name: "InvalidFencedEffectNameError",
    });
    const refused = (() => {
      try {
        fencedEffectKeyOf(
          { step: { nodeId: "n", visitNumber: 1, idempotencyKey: "k" }, fence: {} } as never,
          "charge",
          { businessKey: "" },
        );
      } catch (error: unknown) {
        return error;
      }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(InvalidBusinessKeyError);
    expect(refused).toMatchObject({
      name: "InvalidBusinessKeyError",
      code: "fenced-effect.invalid-business-key",
    });
  });
});
