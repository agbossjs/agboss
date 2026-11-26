/**
 * `ExecutionError.CancelFenced` (#909, #1325b): a write refused after its tree's durable cancel is a
 * CANCEL unwound under the lease the instance still holds — not a hand-over — and, as every cancel,
 * no flow's `.onError` takes it.
 */
import { describe, expect, it } from "vitest";
import * as root from "../../src/index.js";
import * as internal from "../../src/internal.js";
import * as stores from "../../src/stores/index.js";
import { isHandedOver } from "../../src/app/handed-over.js";
import { ExecutionLeaseLostError } from "../../src/app/lease-lost.js";
import { ExecutionError } from "../../src/core/error-families/run-errors.js";
import { HAND_OVER_KINDS, isHandOverError } from "../../src/core/error-families/hand-over.js";
import { ExecutionCancelledError } from "../../src/core/errors.js";
import { isExecutionCancelled } from "../../src/core/execution-cancelled.js";
import { passesThrough } from "../../src/flow/runtime/errors.js";

const key = {
  scopeKey: "acme:root-1",
  tenantId: "acme",
  leaseExecutionId: "child-1",
  token: 3,
  name: "charge",
} as const;

describe("ExecutionError.CancelFenced is a cancel, not a hand-over", () => {
  it("is no hand-over kind, and no hand-over error", () => {
    const refused = stores.cancelFencedOf(key);

    expect(HAND_OVER_KINDS.has(refused.kind)).toBe(false);
    expect(isHandOverError(refused)).toBe(false);
    expect(isHandedOver(refused)).toBe(false);
  });

  it("is a cancel for the one predicate, as a cancel and a stop are; a lost lease is not", () => {
    expect(isExecutionCancelled(stores.cancelFencedOf(key))).toBe(true);
    expect(isExecutionCancelled(new ExecutionCancelledError())).toBe(true);
    expect(isExecutionCancelled(new ExecutionLeaseLostError({ rootExecutionId: "r" }))).toBe(false);
    expect(isExecutionCancelled(new Error("x"))).toBe(false);
  });

  it("passes through a step's code, never wrapped in the step's error", () => {
    expect(passesThrough(stores.cancelFencedOf(key))).toBe(true);
  });

  it("is built by cancelFencedOf(key) with the facts of the refused write", () => {
    const refused = stores.cancelFencedOf({ ...key, rootExecutionId: "root-1" });

    expect(refused).toBeInstanceOf(ExecutionError.CancelFenced);
    expect(refused.code).toBe("execution.cancelled.fenced");
    expect(refused).toMatchObject({
      scopeKey: "acme:root-1",
      tenantId: "acme",
      rootExecutionId: "root-1",
      leaseExecutionId: "child-1",
      token: 3,
      effect: "charge",
    });
    expect(refused.message).toContain('"charge" of execution root-1 was refused');
    expect(stores.cancelFencedOf(key).rootExecutionId).toBe("child-1");
  });

  it("the cancel's abort classes are internal: not in the root entry, in @agboss/core/internal", () => {
    for (const name of [
      "ExecutionCancelledError",
      "ExecutionStoppedError",
      "ExecutionPausedError",
    ]) {
      expect(name in root, name).toBe(false);
      expect(name in internal, name).toBe(true);
    }
    expect("ExecutionCancelFencedError" in root).toBe(false);
  });
});
