import { FENCE } from "../../src/flow/context/execution-fence.js";
/**
 * #626 — the business-key identity's own rules, each found by a mutant that lived: the
 * fingerprint and the handle are derived under their labels (known-answer values), outside a step
 * too; a key without a handle has none at all; a replay names the step that made the effect only
 * when it is another step; an operator's read shows a business key by its handle, or by its name
 * alone; the conflict and the key errors say what they say.
 */
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import {
  businessKeyConflict,
  invalidEffectName,
} from "../../src/infrastructure/idempotency-errors.js";
import { describe, expect, it } from "vitest";
import { keyProblemOf } from "../../src/infrastructure/issued-keys.js";
import { runInFrame, type FrameSpec } from "../../src/flow/context/frame.js";
import {
  BUSINESS_KEY_HANDLE_LABEL,
  businessKeyHashOf,
  FINGERPRINT_LABEL,
  effectKeyOf,
  fingerprintsOf,
  replayedFromOf,
  shownCallOf,
} from "../../src/infrastructure/fenced-effect-key.js";
import type { OutboundCallRecord } from "../../src/infrastructure/outbound-call.repository.js";
import { keyedDigestOf } from "../../src/pii/tokens.js";
import { stableJson } from "../../src/turns/versions.js";
import { testFrame } from "../helpers/frame.js";

/** A step's frame with the execution's keys as given. */
const frameWith = (keys: {
  correlationKey?: string;
  fingerprintKeys?: { current: string; previous?: string };
}): FrameSpec => {
  const frame = testFrame();
  return { ...frame, execution: { ...frame.execution, ...keys } };
};

const inFrame = <TResult>(frame: FrameSpec, work: () => TResult): Promise<TResult> =>
  runInFrame(frame, () => Promise.resolve(work()));

const REQUEST = { amount: 10, currency: "EUR" };
const TEXT = `fingerprint\u0000${stableJson(REQUEST)}`;

/** A business key's step key, made by `executionId`'s step `nodeId` at visit `visitNumber`. */
const keyMadeBy = (origin: { executionId: string; nodeId: string; visitNumber: number }) =>
  effectKeyForTesting({
    scopeKey: "default:execution-1",
    tenantId: "default",
    leaseExecutionId: "execution-1",
    token: 1,
    idempotencyKey: "execution-1:charge-action:1",
    name: "charge",
    businessKey: "order:42",
    origin,
  });

const ORIGIN = { executionId: "execution-1", nodeId: "charge-action", visitNumber: 1 };

describe("#626: the fingerprint and the handle, under their labels", () => {
  it("the labels are the ones the Wiki names", () => {
    expect(FINGERPRINT_LABEL).toBe("agboss/fingerprint/v1");
    expect(BUSINESS_KEY_HANDLE_LABEL).toBe("agboss/business-key-handle/v1");
  });

  it("#825: outside a step, or in one without an idempotency key, a fingerprint is IdempotencyError.SecretKeyMissing — never an unkeyed digest", async () => {
    expect(() => fingerprintsOf(REQUEST, "charge")).toThrow(IdempotencyError.SecretKeyMissing);
    await expect(inFrame(frameWith({}), () => fingerprintsOf(REQUEST, "charge"))).rejects.toThrow(
      IdempotencyError.SecretKeyMissing,
    );
    await expect(
      inFrame(frameWith({ correlationKey: "pii-key" }), () => fingerprintsOf(REQUEST, "charge")),
    ).rejects.toMatchObject({ code: "idempotency.secret-key-missing", effect: "charge" });
  });

  it("in a step with the application's idempotency key it is an HMAC under the label's subkey — never the PII key's", async () => {
    const frame = frameWith({ correlationKey: "pii-key", fingerprintKeys: { current: "app-key" } });
    const fingerprints = await inFrame(frame, () => fingerprintsOf(REQUEST, "charge"));
    const reordered = await inFrame(frame, () =>
      fingerprintsOf({ currency: "EUR", amount: 10 }, "charge"),
    );

    expect(fingerprints).toEqual({
      fingerprint: keyedDigestOf(keyedDigestOf("app-key", "agboss/fingerprint/v1"), TEXT),
    });
    expect(reordered).toEqual(fingerprints);
  });

  it("#825: during a rotation the previous key's fingerprint comes too — matched, never stored", async () => {
    const frame = frameWith({ fingerprintKeys: { current: "new-key", previous: "old-key" } });
    const fingerprints = await inFrame(frame, () => fingerprintsOf(REQUEST, "charge"));

    expect(fingerprints).toEqual({
      fingerprint: keyedDigestOf(keyedDigestOf("new-key", "agboss/fingerprint/v1"), TEXT),
      previousFingerprint: keyedDigestOf(keyedDigestOf("old-key", "agboss/fingerprint/v1"), TEXT),
    });
  });

  it("#825: a fingerprint that is not plain JSON — a DTO instance, a Date — is IdempotencyError.FingerprintNotJson naming the effect, never the value", async () => {
    class ChargeDto {
      amount = 10;
    }
    const frame = frameWith({ fingerprintKeys: { current: "app-key" } });

    for (const value of [new ChargeDto(), { at: new Date(0) }]) {
      const refused = await inFrame(frame, () => {
        try {
          return fingerprintsOf(value, "charge");
        } catch (error) {
          return error;
        }
      });
      expect(refused).toBeInstanceOf(IdempotencyError.FingerprintNotJson);
      expect(refused).toMatchObject({
        code: "idempotency.fingerprint-not-json",
        effect: "charge",
      });
      expect((refused as Error).message).toMatch(
        /^the fingerprint of "charge" is not plain JSON at /u,
      );
    }
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
      root: { executionId: "execution-1" },
      step: {
        nodeId: "charge-action",
        visitNumber: 1,
        idempotencyKey: "execution-1:charge-action:1",
      },
      [FENCE]: {
        scopeKey: "default:execution-1",
        tenantId: "default",
        leaseExecutionId: "execution-1",
        token: 1,
      },
    } as never;

    const key = await inFrame(frameWith({}), () =>
      effectKeyOf(context, "charge", { businessKey: "order:42" }),
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
    expect(replayedFromOf(effectKeyForTesting(noStep), { origin: ORIGIN })).toEqual(ORIGIN);
  });
});

describe("#626: what an operator's read shows of a business key", () => {
  const record = {
    name: "charge",
    businessKey: "order:42",
    fingerprint: "f",
    idempotencyKey: "kozeA6UXkFQOmJlRz1_iDumLcer6Ops_OXo1PjSvjAw",
  } as OutboundCallRecord;

  it("the handle and the name with a handle, the name alone without one; never the key or the fingerprint", () => {
    // the key the call went with is an HMAC (#1317d): shown as it is
    expect(shownCallOf({ ...record, businessKeyHash: "a1b2c3d4e5f6" }).idempotencyKey).toBe(
      record.idempotencyKey,
    );
    expect(shownCallOf(record)).not.toHaveProperty("businessKey");
    expect(shownCallOf(record)).not.toHaveProperty("fingerprint");
  });
});

describe("#626: the key errors", () => {
  it("IdempotencyError.KeyConflict: its name, code and message, with and without a handle", () => {
    const withHandle = businessKeyConflict({ effect: "charge", businessKeyHash: "a1b2" });
    const without = businessKeyConflict({ effect: "charge" });

    expect(withHandle).toMatchObject({
      name: "IdempotencyError.KeyConflict",
      code: "idempotency.key-conflict",
      message:
        '"charge" was already made under the same key (handle a1b2) with other parameters: refused, nothing ran',
    });
    expect(without.message).toBe(
      '"charge" was already made under the same key with other parameters: refused, nothing ran',
    );
    expect(Object.keys(without)).not.toContain("businessKeyHash");
  });

  it("IdempotencyError.InvalidName and IdempotencyError.InvalidKey are named and coded", () => {
    expect(invalidEffectName(0)).toMatchObject({
      name: "IdempotencyError.InvalidName",
    });
    const refused = (() => {
      try {
        effectKeyOf(
          {
            root: { executionId: "execution-1" },
            step: { nodeId: "n", visitNumber: 1, idempotencyKey: "k" },
            [FENCE]: {},
          } as never,
          "charge",
          { businessKey: "" },
        );
      } catch (error: unknown) {
        return error;
      }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(IdempotencyError.InvalidKey);
    expect(refused).toMatchObject({
      name: "IdempotencyError.InvalidKey",
      code: "idempotency.invalid-key",
    });
  });
});

describe("#909: the tree a key's cancel fences, and an undo's key", () => {
  const contextOf = (extra: object) =>
    ({
      executionId: "child-7",
      root: { executionId: "execution-1" },
      step: {
        nodeId: "charge-action",
        visitNumber: 1,
        idempotencyKey: "child-7:charge-action:1",
        ...extra,
      },
      [FENCE]: {
        scopeKey: "default:child-7",
        tenantId: "default",
        leaseExecutionId: "child-7",
        token: 1,
      },
    }) as never;

  it("a key carries its root's execution id (not the child's lease); a step that compensates marks it", async () => {
    const forward = await inFrame(frameWith({}), () => effectKeyOf(contextOf({}), "charge"));
    const undo = await inFrame(frameWith({}), () =>
      effectKeyOf(
        contextOf({ compensates: { nodeId: "charge-action", visitNumber: 1 } }),
        "refund",
      ),
    );

    expect(forward.rootExecutionId).toBe("execution-1");
    expect(forward.leaseExecutionId).toBe("child-7");
    expect(Object.keys(forward)).not.toContain("isCompensation");
    expect(undo.rootExecutionId).toBe("execution-1");
    expect(undo.isCompensation).toBe(true);
  });
});

describe("#825/#909: why a key made by hand is refused", () => {
  const good = keyMadeBy(ORIGIN);

  it("a key of its scope, a whole token from 1 and an idempotency key has no problem", () => {
    expect(keyProblemOf(good)).toBeUndefined();
  });

  it.each([
    [
      { scopeKey: "other:scope" },
      `its scopeKey "other:scope" is not the scope of tenant ${good.tenantId} and execution ${good.leaseExecutionId}`,
    ],
    [{ token: 0 }, "its token 0 is not a lease epoch (a whole number from 1)"],
    [{ token: 1.5 }, "its token 1.5 is not a lease epoch (a whole number from 1)"],
    [{ token: -3 }, "its token -3 is not a lease epoch (a whole number from 1)"],
    [{ idempotencyKey: "" }, "its idempotencyKey must not be empty"],
  ])("%j is named", (change, why) => {
    expect(keyProblemOf(effectKeyForTesting(good, change))).toBe(why);
  });

  it("the errors are named and keep their text and cause", () => {
    const cause = new Error("driver");

    expect(new IdempotencyError.InvalidKey({ message: "not a key" }).name).toBe(
      "IdempotencyError.InvalidKey",
    );
  });
});
