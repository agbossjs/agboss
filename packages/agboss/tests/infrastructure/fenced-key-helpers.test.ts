/**
 * #526 AC5 — the rules of a fenced key, exported by `@agboss/core` so a store outside the core
 * (agbossjs/postgres, a Redis or a MongoDB store) keeps them with the core's own code instead of a
 * copy: the name rule (`checkedEffectName`), the replay and conflict rule (`replayedFromOf`, which
 * takes a row's `null`s and checks a stored step), what a row keeps (`storedKeyFactsOf`), where a
 * key's row is (`fencedKeyIdentityOf`) and the record of an outbound call's intent
 * (`pendingOutboundCallOf`). The core's own stores use the same functions.
 */
import { describe, expect, it } from "vitest";
import * as root from "../../src/index.js";
import {
  checkedEffectName,
  fencedKeyIdentityOf,
  IdempotencyKeyConflictError,
  InvalidFencedEffectNameError,
  OutboundCallStatus,
  pendingOutboundCallOf,
  replayedFromOf,
  storedKeyFactsOf,
  type FencedEffectKey,
  type OutboundCallIntent,
  type StoredKeyFacts,
} from "../../src/index.js";

const STEP: FencedEffectKey = {
  scopeKey: "default:root-1",
  tenantId: "default",
  leaseExecutionId: "root-1",
  token: 2,
  idempotencyKey: "root-1:charge-action:1",
  name: "charge",
  origin: { executionId: "root-1", nodeId: "charge-action", visitNumber: 1 },
};

const BUSINESS: FencedEffectKey = {
  ...STEP,
  businessKey: "order:42",
  fingerprint: "f-10",
  businessKeyHash: "a1b2c3d4e5f6",
};

const OTHER_STEP = { executionId: "root-2", nodeId: "charge-action", visitNumber: 3 };

describe("#526 AC5: the helpers are on the root entry", () => {
  it.each([
    "checkedEffectName",
    "fencedKeyIdentityOf",
    "pendingOutboundCallOf",
    "replayedFromOf",
    "storedKeyFactsOf",
    "LeaseCheck",
  ])("%s is exported by @agboss/core", (name) => {
    expect(name in root).toBe(true);
  });
});

describe("#526 AC5: checkedEffectName — the name rule", () => {
  it.each(["charge", "a", "Charge.v2", "x-1_2", "9lives", "x".repeat(100)])(
    "%s is a name",
    (name) => {
      expect(() => {
        checkedEffectName(name);
      }).not.toThrow();
    },
  );

  it.each([
    ["", "empty"],
    ["charge:twice", "a ':' of the keys it is in"],
    ["x".repeat(101), "above 100"],
    [".charge", "a '.' first"],
    ["-charge", "a '-' first"],
    ["_charge", "a '_' first"],
    ["char ge", "a space"],
    ["charge\u0000", "a control character"],
    ["chärge", "a letter outside A–Z"],
    ["charge/1", "a '/'"],
  ])("%j is refused (%s): InvalidFencedEffectNameError with its length, never the name", (name) => {
    let thrown: unknown;
    try {
      checkedEffectName(name);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvalidFencedEffectNameError);
    expect(thrown).toMatchObject({ code: "fenced-effect.invalid-name" });
    expect((thrown as Error).message).toContain(`(${String(name.length)} characters)`);
    if (name.length > 0) expect((thrown as Error).message).not.toContain(name);
  });
});

describe("#526 AC5: replayedFromOf — the replay and conflict rule", () => {
  it("a step's own key replays without naming a step, whatever the row says", () => {
    expect(replayedFromOf(STEP, {})).toBeUndefined();
    expect(replayedFromOf(STEP, { fingerprint: "other", origin: OTHER_STEP })).toBeUndefined();
  });

  it("a business key's row of another step names that step", () => {
    expect(replayedFromOf(BUSINESS, { fingerprint: "f-10", origin: OTHER_STEP })).toEqual(
      OTHER_STEP,
    );
  });

  it("a business key's row of its own step, or one without its step, names none", () => {
    expect(
      replayedFromOf(BUSINESS, { fingerprint: "f-10", origin: BUSINESS.origin }),
    ).toBeUndefined();
    expect(replayedFromOf(BUSINESS, { fingerprint: "f-10" })).toBeUndefined();
    expect(replayedFromOf(BUSINESS, { fingerprint: "f-10", origin: null })).toBeUndefined();
  });

  it.each([
    ["another fingerprint", { fingerprint: "f-12" }],
    ["none stored, one given", {}],
    ["a null stored, one given", { fingerprint: null }],
  ] as const)(
    "%s under one business key is IdempotencyKeyConflictError, with the handle and never the key",
    (_case, stored: StoredKeyFacts) => {
      let thrown: unknown;
      try {
        replayedFromOf(BUSINESS, stored);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(IdempotencyKeyConflictError);
      expect(thrown).toMatchObject({ effect: "charge", businessKeyHash: "a1b2c3d4e5f6" });
      expect((thrown as Error).message).not.toContain("order:42");
    },
  );

  it("a key without a fingerprint replays a row with none — a null column is none", () => {
    const bare = { ...BUSINESS, fingerprint: undefined };

    expect(replayedFromOf(bare, { fingerprint: null, origin: OTHER_STEP })).toEqual(OTHER_STEP);
    expect(replayedFromOf(bare, {})).toBeUndefined();
    expect(() => replayedFromOf(bare, { fingerprint: "f-10" })).toThrow(
      IdempotencyKeyConflictError,
    );
  });

  it.each([
    ["a text", "root-2"],
    ["a step without its visit", { executionId: "root-2", nodeId: "charge-action" }],
    ["a visit that is not a whole number", { ...OTHER_STEP, visitNumber: 1.5 }],
    ["a node that is not a text", { ...OTHER_STEP, nodeId: 7 }],
    ["an execution that is not a text", { ...OTHER_STEP, executionId: null }],
  ])("a stored step that is not one (%s) is refused, never trusted", (_case, origin) => {
    expect(() => replayedFromOf(BUSINESS, { fingerprint: "f-10", origin })).toThrow(
      "a stored fenced-effect row's origin is not a step ({ executionId, nodeId, visitNumber })",
    );
  });

  it("a stored step comes back as it was read (a JSON column parsed)", () => {
    const origin: unknown = JSON.parse(JSON.stringify(OTHER_STEP));

    expect(replayedFromOf(BUSINESS, { fingerprint: "f-10", origin })).toEqual(OTHER_STEP);
  });
});

describe("#526 AC5: storedKeyFactsOf — what a row keeps", () => {
  it("a business key's fingerprint and step", () => {
    expect(storedKeyFactsOf(BUSINESS)).toEqual({ fingerprint: "f-10", origin: BUSINESS.origin });
  });

  it("nothing a key does not have — absent, never undefined", () => {
    const facts = storedKeyFactsOf({ ...STEP, origin: undefined });

    expect(facts).toEqual({});
    expect(Object.keys(facts)).toEqual([]);
  });

  it("round trip: what it keeps replays the same key, and names another step's key", () => {
    const stored = JSON.parse(JSON.stringify(storedKeyFactsOf(BUSINESS))) as StoredKeyFacts;

    expect(replayedFromOf(BUSINESS, stored)).toBeUndefined();
    expect(replayedFromOf({ ...BUSINESS, origin: OTHER_STEP }, stored)).toEqual(BUSINESS.origin);
  });
});

describe("#526 AC5: fencedKeyIdentityOf — where a key's row is", () => {
  it("a step's key: its scope, idempotency key and name", () => {
    expect(fencedKeyIdentityOf(STEP)).toBe(
      "default:root-1\u0000root-1:charge-action:1\u0000charge",
    );
  });

  it("a business key: its tenant, name and business key — not the scope, the token or the step", () => {
    const identity = fencedKeyIdentityOf(BUSINESS);

    expect(identity).toBe("business\u0000default\u0000charge\u0000order:42");
    expect(
      fencedKeyIdentityOf({
        ...BUSINESS,
        scopeKey: "default:root-9",
        token: 7,
        origin: OTHER_STEP,
      }),
    ).toBe(identity);
  });

  it("another name, tenant or business key is another row; a step's key never meets a business key's", () => {
    const rows = new Set([
      fencedKeyIdentityOf(STEP),
      fencedKeyIdentityOf({ ...STEP, name: "refund" }),
      fencedKeyIdentityOf({ ...STEP, idempotencyKey: "root-1:charge-action:2" }),
      fencedKeyIdentityOf(BUSINESS),
      fencedKeyIdentityOf({ ...BUSINESS, tenantId: "acme" }),
      fencedKeyIdentityOf({ ...BUSINESS, businessKey: "order:43" }),
      fencedKeyIdentityOf({ ...BUSINESS, name: "refund" }),
    ]);

    expect(rows.size).toBe(7);
  });
});

const INTENT: OutboundCallIntent = {
  rootExecutionId: "root-1",
  executionId: "root-1",
  workflow: "charge-workflow",
  target: "payments",
  operation: "charge",
  idempotencyKey: "root-1:charge-action:1:charge",
  request: '{"orderId":"order-7"}',
  attempt: 1,
  attemptOwner: "owner-1",
  step: { nodeId: "charge-action", visitNumber: 1 },
};

describe("#526 AC5: pendingOutboundCallOf — the record saveIfAbsent keeps", () => {
  const AT = new Date("2026-01-05T09:00:00.000Z");

  it("a step's key: the intent, Pending under the key's lease and token, when", () => {
    expect(pendingOutboundCallOf(STEP, INTENT, AT)).toEqual({
      ...INTENT,
      tenantId: "default",
      name: "charge",
      status: OutboundCallStatus.Pending,
      token: 2,
      leaseExecutionId: "root-1",
      recordedAt: "2026-01-05T09:00:00.000Z",
      // #658: its first attempt starts when it is recorded
      attemptStartedAt: "2026-01-05T09:00:00.000Z",
      firstAttemptStartedAt: "2026-01-05T09:00:00.000Z",
    });
  });

  it("a business key: its key, fingerprint and handle too", () => {
    expect(pendingOutboundCallOf(BUSINESS, INTENT, AT)).toMatchObject({
      businessKey: "order:42",
      fingerprint: "f-10",
      businessKeyHash: "a1b2c3d4e5f6",
    });
  });

  it("nothing of a business identity for a step's key — absent, not undefined", () => {
    const record = pendingOutboundCallOf(STEP, INTENT, AT);

    for (const field of ["businessKey", "fingerprint", "businessKeyHash", "result", "endedAt"])
      expect(field in record).toBe(false);
  });

  it("the status is the enum's own value: a store reading it back compares equal", () => {
    const stored = JSON.parse(JSON.stringify(pendingOutboundCallOf(STEP, INTENT, AT))) as {
      status: string;
    };

    expect(stored.status).toBe(OutboundCallStatus.Pending);
  });

  it("a new object each time: the intent is not changed", () => {
    const intent = { ...INTENT };
    const record = pendingOutboundCallOf(STEP, intent, AT);

    expect(record).not.toBe(intent);
    expect(intent).toEqual(INTENT);
  });
});
