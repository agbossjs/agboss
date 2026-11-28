/** #1356 (WP6, takeover shard): the hooks a holder runs when a write meets its tree's cancel or stop, and the cancel-fenced finder. */
import { describe, expect, it, vi } from "vitest";
import { cancelFencedErrorOf } from "../../src/app/handed-over.js";
import { CancelFoundHooks } from "../../src/app/lease-yields.js";
import { ExecutionError } from "../../src/core/error-families/run-errors.js";

describe("CancelFoundHooks", () => {
  it("tells every listener the refusal, in the order they were added, each time a cancel is found", () => {
    const hooks = new CancelFoundHooks();
    const told: string[] = [];
    hooks.whenCancelFound((cause) => told.push(`a:${cause.message}`));
    hooks.whenCancelFound((cause) => told.push(`b:${cause.message}`));

    hooks.cancelFound(new Error("first"));
    hooks.cancelFound(new Error("second"));

    expect(told).toStrictEqual(["a:first", "b:first", "a:second", "b:second"]);
  });

  it("tells nobody before a cancel is found", () => {
    const hooks = new CancelFoundHooks();
    const listener = vi.fn();
    hooks.whenCancelFound(listener);

    expect(listener).not.toHaveBeenCalled();
    expect(() => {
      hooks.cancelFound(new Error("x"));
    }).not.toThrow();
  });

  it("an AfterStep stop is none until found, then the first one found, never replaced", () => {
    const hooks = new CancelFoundHooks();
    const first = new Error("first stop");

    expect(hooks.stoppedAfterStep).toBeUndefined();
    hooks.stopAfterStep(first);
    hooks.stopAfterStep(new Error("second stop"));

    expect(hooks.stoppedAfterStep).toBe(first);
  });
});

describe("cancelFencedErrorOf", () => {
  it("is the error itself, or the one in its cause chain, and none for anything else", () => {
    const fenced = new ExecutionError.CancelFenced();
    const wrapped = new Error("outer", { cause: new Error("middle", { cause: fenced }) });

    expect(cancelFencedErrorOf(fenced)).toBe(fenced);
    expect(cancelFencedErrorOf(wrapped)).toBe(fenced);
    expect(cancelFencedErrorOf(new Error("plain"))).toBeUndefined();
    expect(
      cancelFencedErrorOf(
        new ExecutionError.Fenced({
          scopeKey: "acme:root-1",
          tenantId: "acme",
          leaseExecutionId: "root-1",
          token: 3,
        }),
      ),
    ).toBeUndefined();
    expect(cancelFencedErrorOf("text")).toBeUndefined();
    expect(cancelFencedErrorOf(undefined)).toBeUndefined();
  });
});
