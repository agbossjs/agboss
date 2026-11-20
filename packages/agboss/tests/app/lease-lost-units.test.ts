/**
 * #1356 (cancel shard) — the errors of a lease that is over and of a write that was refused (#265, #471,
 * #567, #890, #909, #1090), each on its own: its name and fields, its message by what the refusal knows,
 * the scope key's two parts, and the invariants the holder reads with `definedOf`.
 */
import { describe, expect, it } from "vitest";
import {
  ExecutionCancelFencedError,
  ExecutionFencedError,
  ExecutionLeaseLostError,
  heldAtRelease,
  heldWhileYieldsRun,
  leaseExpiredError,
  leaseLostBeforeStartError,
  leaseTakenWhileYieldedError,
  scopeKeyOf,
  scopeOfKey,
} from "../../src/app/lease-lost.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";

describe("#1356: a lease that is over", () => {
  it("is named, with the execution whose lease it was and the cause", () => {
    const cause = new Error("store down");
    const error = new ExecutionLeaseLostError({ rootExecutionId: "root-1", cause });

    expect(error.name).toBe("ExecutionLeaseLostError");
    expect(error.code).toBe("execution.lease-lost");
    expect(error.rootExecutionId).toBe("root-1");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe(
      "the lease of execution root-1 is over — it expired, or another instance took it: this instance stops, the next take of the lease continues the execution",
    );
  });

  it("expired before its store confirmed a renewal: the same class and fields, its own message", () => {
    const error = leaseExpiredError("root-1");

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(error.rootExecutionId).toBe("root-1");
    expect(error.code).toBe("execution.lease-lost");
    expect(error.message).toBe(
      "the lease of execution root-1 expired before its store confirmed a renewal — the holder was frozen, or its store did not answer, for longer than the lease: this instance stops, the next take of the lease continues the execution",
    );
  });

  it("taken while its holder waited for remote children: its own message", () => {
    const error = leaseTakenWhileYieldedError("root-1");

    expect(error.rootExecutionId).toBe("root-1");
    expect(error.message).toBe(
      "the lease of execution root-1 is over — it expired while it waited for remote children, or another instance took it: this instance stops, the next take of the lease continues the execution",
    );
  });

  it("lost before the first checkpoint: the same execution and cause, a code of its own, a message that says the run did not start", () => {
    const cause = new Error("renewal refused");
    const lost = new ExecutionLeaseLostError({ rootExecutionId: "root-1", cause });

    const error = leaseLostBeforeStartError(lost);

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(error).not.toBe(lost);
    expect(error.rootExecutionId).toBe("root-1");
    expect(error.cause).toBe(cause);
    expect(error.code).toBe("execution.lease-lost.not-started");
    expect(error.message).toBe(
      "the lease of execution root-1 was lost before the run stored its first checkpoint: the run did not start, nothing is left for the next take to continue (its record ends failed) — start it again",
    );
  });
});

describe("#1356: the scope key of a lease", () => {
  it("is the tenant and the execution, each URI-encoded, with exactly one colon", () => {
    expect(scopeKeyOf("acme", "root-1")).toBe("acme:root-1");
    expect(scopeKeyOf("a:b", "c d/é")).toBe("a%3Ab:c%20d%2F%C3%A9");
  });

  it("reads back into its two parts", () => {
    expect(scopeOfKey("acme:root-1")).toStrictEqual({
      tenantId: "acme",
      leaseExecutionId: "root-1",
    });
    expect(scopeOfKey(scopeKeyOf("a:b", "c d/é"))).toStrictEqual({
      tenantId: "a:b",
      leaseExecutionId: "c d/é",
    });
    expect(scopeOfKey(":")).toStrictEqual({ tenantId: "", leaseExecutionId: "" });
  });

  it("is none for a text that is not one: no colon, two, or a malformed escape", () => {
    expect(scopeOfKey("acme")).toBeUndefined();
    expect(scopeOfKey("a:b:c")).toBeUndefined();
    expect(scopeOfKey("a%:b")).toBeUndefined();
    expect(scopeOfKey("a:b%E0%A4")).toBeUndefined();
  });
});

describe("#1356: a write an external system refused", () => {
  const refusal = { scopeKey: "acme:root-1", token: 3 };

  it("has the scope's parts, the tokens and the cause", () => {
    const cause = new Error("driver");
    const error = new ExecutionFencedError({
      scopeKey: "acme:root-1",
      tenantId: "acme",
      leaseExecutionId: "root-1",
      token: 3,
      observedToken: 5,
      cause,
    });

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(error.name).toBe("ExecutionFencedError");
    expect(error.code).toBe("execution.lease-lost.fenced");
    expect(error.rootExecutionId).toBe("root-1");
    expect(error.leaseExecutionId).toBe("root-1");
    expect(error.tenantId).toBe("acme");
    expect(error.scopeKey).toBe("acme:root-1");
    expect(error.token).toBe(3);
    expect(error.observedToken).toBe(5);
    expect(error.cause).toBe(cause);
  });

  it("a newer token seen is a newer take of the lease", () => {
    expect(ExecutionFencedError.of({ ...refusal, observedToken: 5 }).message).toBe(
      "a write of lease scope acme:root-1 with token 3 was refused: the external system saw token 5 — a newer take of the lease: this instance stops, the holder of token 5 continues the execution",
    );
  });

  it("the same token, or an older one, is only a lease that is over", () => {
    const over =
      "the lease is over: it expired, was released, or another instance took it; this instance stops, the next take of the lease continues the execution";

    expect(ExecutionFencedError.of({ ...refusal, observedToken: 3 }).message).toBe(
      `a write of lease scope acme:root-1 with token 3 was refused: the external system saw token 3, no newer take — ${over}`,
    );
    expect(ExecutionFencedError.of({ ...refusal, observedToken: 2 }).message).toContain(
      "the external system saw token 2, no newer take — the lease is over",
    );
  });

  it("no token seen is only a lease that is over, too", () => {
    expect(ExecutionFencedError.of(refusal).message).toBe(
      "a write of lease scope acme:root-1 with token 3 was refused: the external system named no newer token — the lease is over: it expired, was released, or another instance took it; this instance stops, the next take of the lease continues the execution",
    );
    expect(ExecutionFencedError.of(refusal).observedToken).toBeUndefined();
  });

  it("built from a scope key alone, the key is read into its parts", () => {
    const error = ExecutionFencedError.of({ scopeKey: "a%3Ab:c%20d", token: 1 });

    expect(error.tenantId).toBe("a:b");
    expect(error.leaseExecutionId).toBe("c d");
    expect(error.rootExecutionId).toBe("c d");
  });

  it("a key that is no scope key is a TypeError, named, saying what it is not", () => {
    let caught: unknown;
    try {
      ExecutionFencedError.of({ scopeKey: "nonsense", token: 1 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toHaveProperty("name", "InvalidScopeKeyError");
    expect(caught).toHaveProperty(
      "message",
      '"nonsense" is not a scope key (executionContext.fence.scopeKey)',
    );
  });
});

describe("#1356: a write the tree's cancel refused", () => {
  const key = {
    scopeKey: "acme:lease-1",
    tenantId: "acme",
    leaseExecutionId: "lease-1",
    rootExecutionId: "root-1",
    token: 4,
    name: "charge",
  };

  it("names the write's scope, tokens and effect, and the root whose cancel it is", () => {
    const error = ExecutionCancelFencedError.of(key);

    expect(error).toBeInstanceOf(ExecutionCancelledError);
    expect(error.name).toBe("ExecutionCancelFencedError");
    expect(error.code).toBe("execution.cancelled.fenced");
    expect(error.scopeKey).toBe("acme:lease-1");
    expect(error.tenantId).toBe("acme");
    expect(error.leaseExecutionId).toBe("lease-1");
    expect(error.rootExecutionId).toBe("root-1");
    expect(error.token).toBe(4);
    expect(error.effect).toBe("charge");
    expect(error.message).toBe(
      '"charge" of execution root-1 was refused: its tree\'s cancel was requested — nothing was written or sent',
    );
  });

  it("the root is the lease's execution when the key names none", () => {
    const { rootExecutionId: _root, ...withoutRoot } = key;

    expect(ExecutionCancelFencedError.of(withoutRoot).rootExecutionId).toBe("lease-1");
  });

  it("keeps the cause it is given", () => {
    const cause = new Error("driver");

    expect(new ExecutionCancelFencedError({ ...key, effect: "charge", cause }).cause).toBe(cause);
  });
});

describe("#1356: the invariants of a held lease", () => {
  it("are the lease itself when it is there", () => {
    const lease = { token: 1 } as never;

    expect(heldAtRelease(lease)).toBe(lease);
    expect(heldWhileYieldsRun(lease)).toBe(lease);
  });

  it("say which invariant was broken when it is not", () => {
    expect(() => heldAtRelease(undefined)).toThrow(
      "unreachable: a held lease is cleared only by a release past its #stopped check, which a second release never gets past",
    );
    expect(() => heldWhileYieldsRun(undefined)).toThrow(
      "unreachable: the yields' callback returns once #stopped aborts, which a release does before it clears the lease",
    );
  });
});
