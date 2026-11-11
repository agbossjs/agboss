/**
 * #890 AC3 (API review G8, A-runtime Part 9): the errors of 0.1.1 have one shape — an options bag for
 * two facts or more, its keys the error's own fields (`effect` on a fenced effect's, `call` on an
 * outbound call's, `cause` among them), a literal `static code` so `switch (error.code)` narrows —
 * and names that say what failed: `BusinessKeyConflictError`, `ThreadIdsExhaustedError`,
 * `SyncWorkRequiredError`.
 */
import { describe, expect, it } from "vitest";
import * as root from "../../src/index.js";
import {
  BusinessKeyConflictError,
  ExecutionFencedError,
  FingerprintNotJsonError,
  InvalidBusinessKeyError,
  InvalidMintedIdError,
  KeyTextRule,
  OutboundCallInFlightError,
  OutboundCallSupersededError,
  OutboundCallUnreconciledError,
  QuestionFailedError,
  SyncWorkRequiredError,
  ThreadIdsExhaustedError,
} from "../../src/index.js";

describe("#890 AC3: the errors say what failed", () => {
  it("AC3: BusinessKeyConflictError, ThreadIdsExhaustedError, SyncWorkRequiredError, with codes by mechanism", () => {
    expect(BusinessKeyConflictError.code).toBe("fenced-effect.business-key-conflict");
    expect(ThreadIdsExhaustedError.code).toBe("run.thread-ids-exhausted");
    expect(SyncWorkRequiredError.code).toBe("fenced-effect.sync-work-required");
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
    expect(new BusinessKeyConflictError({ effect: "charge" }).effect).toBe("charge");
    expect(
      new InvalidBusinessKeyError({ effect: "charge", rule: KeyTextRule.Length }),
    ).toMatchObject({ effect: "charge", rule: KeyTextRule.Length });
    expect(
      new FingerprintNotJsonError({ effect: "charge", path: "$.at", reason: "a Date" }),
    ).toMatchObject({ effect: "charge", path: "$.at", reason: "a Date" });
  });

  it("AC3: call on an outbound call's errors, cause in the bag", () => {
    const cause = new Error("the gateway is down");
    const call = { call: "charge", target: "payments", operation: "charge" };

    expect(new OutboundCallInFlightError(call)).toMatchObject(call);
    expect(
      new OutboundCallUnreconciledError({
        ...call,
        idempotencyKey: "k-1",
        reason: "reconcile.threw",
        detail: "reconcile threw: the gateway is down",
        cause,
      }),
    ).toMatchObject({ ...call, reason: "reconcile.threw", cause });
    expect(
      new OutboundCallSupersededError({
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
      new InvalidMintedIdError({ generator: "G", method: "newThreadId", rule: KeyTextRule.Length }),
    ).toMatchObject({ generator: "G", method: "newThreadId", rule: KeyTextRule.Length });
    expect(new ThreadIdsExhaustedError({ generator: "G", tries: 100 })).toMatchObject({
      generator: "G",
      tries: 100,
    });
    expect(new QuestionFailedError({ question: "limit-question", cause })).toMatchObject({
      question: "limit-question",
      cause,
    });
  });
});

describe("#890 AC3: ExecutionFencedError.of validates, the constructor does not throw", () => {
  it("AC3: of reads the scope key; a malformed one is refused there", () => {
    expect(ExecutionFencedError.of({ scopeKey: "acme:root-1", token: 2 })).toMatchObject({
      tenantId: "acme",
      leaseExecutionId: "root-1",
      token: 2,
    });
    expect(() => ExecutionFencedError.of({ scopeKey: "no-scope", token: 2 })).toThrow(TypeError);
  });
});
