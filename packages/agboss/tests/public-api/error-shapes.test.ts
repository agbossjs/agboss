import { StepError } from "../../src/core/error-families/step-errors.js";
import { fencedRefusalOf } from "../../src/app/lease-lost.js";
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
/**
 * #890 AC3 (API review G8, A-runtime Part 9): the errors of 0.1.1 have one shape — an options bag for
 * two facts or more, its keys the error's own fields (`effect` on a fenced effect's, `call` on an
 * outbound call's, `cause` among them), a literal `static code` so `switch (error.code)` narrows —
 * and names that say what failed: `IdempotencyError.KeyConflict`, `ExecutionError.ThreadIdsExhausted`.
 */
import {
  IdempotencyError,
  OutboundCallError,
} from "../../src/core/error-families/effect-errors.js";
import { describe, expect, it } from "vitest";
import * as root from "../../src/index.js";
import { KeyTextRule } from "../../src/index.js";

describe("#890 AC3: the errors say what failed", () => {
  it("AC3: IdempotencyError.KeyConflict, ExecutionError.ThreadIdsExhausted, with codes by mechanism", () => {
    expect(new IdempotencyError.KeyConflict({ effect: "charge" }).code).toBe(
      "idempotency.key-conflict",
    );
    expect(ExecutionError.ThreadIdsExhausted.code).toBe("execution.thread-ids-exhausted");
  });

  it("AC3: the old names are gone from the root entry, no aliases", () => {
    const names = Object.keys(root);

    expect(names).not.toContain("IdempotencyKeyConflictError");
    expect(names).not.toContain("DuplicateThreadIdError");
    expect(names).not.toContain("FencedEffectAsyncWorkError");
  });
});

describe("#890 AC3: an options bag, its keys the error's fields", () => {
  it("AC3: effect on a fenced effect's errors", () => {
    expect(new IdempotencyError.KeyConflict({ effect: "charge" }).effect).toBe("charge");
    expect(
      new IdempotencyError.InvalidKey({ effect: "charge", rule: KeyTextRule.Length }),
    ).toMatchObject({ effect: "charge", rule: KeyTextRule.Length });
    expect(
      new IdempotencyError.FingerprintNotJson({ effect: "charge", path: "$.at", reason: "a Date" }),
    ).toMatchObject({ effect: "charge", path: "$.at", reason: "a Date" });
  });

  it("AC3: call on an outbound call's errors, cause in the bag", () => {
    const cause = new Error("the gateway is down");
    const call = { call: "charge", target: "payments", operation: "charge" };

    expect(new OutboundCallError.InFlight(call)).toMatchObject(call);
    expect(
      new OutboundCallError.Unreconciled({
        ...call,
        idempotencyKey: "k-1",
        reason: "reconcile.threw",
        detail: "reconcile threw: the gateway is down",
        cause,
      }),
    ).toMatchObject({ ...call, reason: "reconcile.threw", cause });
    expect(
      new OutboundCallError.Superseded({
        ...call,
        idempotencyKey: "k-1",
        attempt: 1,
        supersededBy: 2,
        cause,
      }),
    ).toMatchObject({ ...call, attempt: 1, supersededBy: 2, cause });
  });

  it("AC3: the ids' errors and the question's", () => {
    const cause = new Error("send failed");

    expect(
      new ExecutionError.InvalidMintedId({
        generator: "G",
        method: "newThreadId",
        rule: KeyTextRule.Length,
      }),
    ).toMatchObject({ generator: "G", method: "newThreadId", rule: KeyTextRule.Length });
    expect(new ExecutionError.ThreadIdsExhausted({ generator: "G", tries: 100 })).toMatchObject({
      generator: "G",
      tries: 100,
    });
    expect(
      new StepError.ExternalTask({ externalTask: "limit-external-task", cause }),
    ).toMatchObject({
      externalTask: "limit-external-task",
      cause,
    });
  });
});

describe("#890 AC3: ExecutionError.Fenced.of validates, the constructor does not throw", () => {
  it("AC3: of reads the scope key; a malformed one is refused there", () => {
    expect(fencedRefusalOf({ scopeKey: "acme:root-1", token: 2 })).toMatchObject({
      tenantId: "acme",
      leaseExecutionId: "root-1",
      token: 2,
    });
    expect(() => fencedRefusalOf({ scopeKey: "no-scope", token: 2 })).toThrow(TypeError);
  });
});
