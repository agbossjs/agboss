/**
 * #909 — what a holder does when a write of its steps meets its tree's cancel: `cancelMet` tells
 * and stops the tree through the lease for a refusal by the cancel only (also one a driver wrapped),
 * and the hooks run each listener once a refusal is told, none before.
 */
import { describe, expect, it, vi } from "vitest";
import { cancelMet } from "../../src/app/handed-over.js";
import { CancelFoundHooks } from "../../src/app/lease-yields.js";
import { ExecutionCancelFencedError } from "../../src/app/lease-lost.js";

const REFUSAL = ExecutionCancelFencedError.of({
  scopeKey: "default:execution-1",
  tenantId: "default",
  leaseExecutionId: "execution-1",
  rootExecutionId: "execution-1",
  token: 1,
  name: "charge",
});

describe("#909: cancelMet", () => {
  it("a refusal by the cancel: told first, then the lease stops the tree with that error", () => {
    const order: string[] = [];
    const cancelFound = vi.fn(() => order.push("stopped"));

    cancelMet(REFUSAL, { cancelFound }, () => order.push("told"));

    expect(order).toEqual(["told", "stopped"]);
    expect(cancelFound).toHaveBeenCalledWith(REFUSAL);
  });

  it("the refusal under a wrapper's cause is found too", () => {
    const cancelFound = vi.fn();

    cancelMet(new Error("driver", { cause: REFUSAL }), { cancelFound }, () => undefined);

    expect(cancelFound).toHaveBeenCalledWith(REFUSAL);
  });

  it("any other error: nothing told, nothing stopped", () => {
    const cancelFound = vi.fn();
    const tell = vi.fn();

    cancelMet(new Error("a store error"), { cancelFound }, tell);

    expect(tell).not.toHaveBeenCalled();
    expect(cancelFound).not.toHaveBeenCalled();
  });

  it("a lease that cannot stop the tree (a unit runner's): told, and no error", () => {
    const tell = vi.fn();

    expect(() => {
      cancelMet(REFUSAL, {}, tell);
    }).not.toThrow();
    expect(tell).toHaveBeenCalledTimes(1);
  });
});

describe("#909: CancelFoundHooks", () => {
  it("runs every listener, in order, when told; none before; again on each telling", () => {
    const hooks = new CancelFoundHooks();
    const ran: string[] = [];
    hooks.whenCancelFound(() => ran.push("a"));
    hooks.whenCancelFound(() => ran.push("b"));

    expect(ran).toEqual([]);
    hooks.cancelFound();
    expect(ran).toEqual(["a", "b"]);
    hooks.cancelFound();
    expect(ran).toEqual(["a", "b", "a", "b"]);
  });

  it("with no listener, telling does nothing", () => {
    expect(() => {
      new CancelFoundHooks().cancelFound();
    }).not.toThrow();
  });
});
