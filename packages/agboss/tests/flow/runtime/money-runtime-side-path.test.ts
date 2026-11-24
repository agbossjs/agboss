/**
 * #1366 (money-runtime shard) — the side path an execution is on after an `.onError` took a failure (#656), each rule on
 * its own: where it leads and whether it took a limit (its actions then run past the budgets), the undos it owes (the
 * entries open when it was entered), what a visit that succeeded leaves of it, and when a visit is an owed undo, which
 * the budgets never refuse (it gives the money back).
 */
import { describe, expect, it } from "vitest";
import { errorRecordOf } from "../../../src/core/error-record.js";
import { CompensationEntryStatus } from "../../../src/flow/compensation.js";
import {
  isOwedUndo,
  sidePathAfter,
  sidePathEntered,
  sidePathOf,
} from "../../../src/flow/runtime/limits.js";
import { LimitExceededError } from "../../../src/graph/limits.js";

const node = (id: string) => ({ id }) as never;
const entry = (key: string, compensator: string, sequence: number, status = "open") => ({
  key,
  compensator,
  sequence,
  status: status as CompensationEntryStatus,
});
const stateOf = (changes: Record<string, unknown> = {}) =>
  ({ sidePath: null, compensations: [], ...changes }) as never;

const limit = errorRecordOf(
  new LimitExceededError({ key: "k", limit: 1, actual: 2, path: [], spentUsd: 0, usage: [] }),
);
const plain = errorRecordOf(new Error("boom"));

describe("#1366: the side path a visit is on", () => {
  const on = { next: "refund", isAfterLimit: true, owed: ["k1"] };

  it("is the state's, for the node it leads to and no other, and none off a side path", () => {
    expect(sidePathOf(stateOf({ sidePath: on }), node("refund"))).toBe(on);
    expect(sidePathOf(stateOf({ sidePath: on }), node("other"))).toBeUndefined();
    expect(sidePathOf(stateOf(), node("refund"))).toBeUndefined();
  });
});

describe("#1366: a side path entered", () => {
  const open = [
    entry("k1", "undo-a", 1),
    entry("k2", "undo-b", 2, "closed"),
    entry("k3", "undo-c", 3),
    entry("k4", "undo-d", 4, "committed"),
  ];

  it("leads to the node the failure was taken to, owes the undos of every entry open now, and took a limit when the failure is one", () => {
    const out = sidePathEntered(stateOf({ compensations: open }), limit, "handle");

    expect(out).toEqual({ sidePath: { next: "handle", isAfterLimit: true, owed: ["k1", "k3"] } });
  });

  it("a failure that is no limit, taken by a visit off any side path, did not take one", () => {
    const out = sidePathEntered(stateOf(), plain, "handle", node("failing"));

    expect(out).toEqual({ sidePath: { next: "handle", isAfterLimit: false, owed: [] } });
  });

  it("a failure taken out of no visit (a launch's join) while the execution is on a side path leads on to the node, off any", () => {
    const state = stateOf({ sidePath: { next: "failing", isAfterLimit: true, owed: ["k"] } });

    expect(sidePathEntered(state, plain, "handle")).toEqual({
      sidePath: { next: "handle", isAfterLimit: false, owed: [] },
    });
  });

  it("a failure of a visit on a side path that took a limit leads on from it, whatever the failure is", () => {
    const state = stateOf({ sidePath: { next: "failing", isAfterLimit: true, owed: [] } });

    expect(sidePathEntered(state, plain, "handle", node("failing")).sidePath.isAfterLimit).toBe(
      true,
    );
  });

  it("a failure of a visit on a side path that took none, or of another node, took none", () => {
    const state = stateOf({ sidePath: { next: "failing", isAfterLimit: false, owed: [] } });

    expect(sidePathEntered(state, plain, "handle", node("failing")).sidePath.isAfterLimit).toBe(
      false,
    );
    expect(sidePathEntered(state, plain, "handle", node("other")).sidePath.isAfterLimit).toBe(
      false,
    );
  });
});

describe("#1366: what a visit that succeeded leaves of its side path", () => {
  const on = { next: "refund", isAfterLimit: true, owed: ["k1"] };
  const state = stateOf({ sidePath: on });

  it("it goes on to the node the visit leads to, keeping what it took and what it owes", () => {
    expect(sidePathAfter(state, node("refund"), "notify")).toEqual({
      sidePath: { next: "notify", isAfterLimit: true, owed: ["k1"] },
    });
  });

  it.each([
    ["a visit off the side path", node("other"), "notify"],
    ["a visit that leads nowhere (a finish)", node("refund"), undefined],
    ["a visit that leads to no node (a launch)", node("refund"), ""],
  ])("%s ends it", (_why, visited, next) => {
    expect(sidePathAfter(state, visited, next)).toEqual({ sidePath: null });
  });
});

describe("#1366: an owed undo", () => {
  const owing = {
    sidePath: { next: "undo-b", isAfterLimit: false, owed: ["k2"] },
    compensations: [entry("k1", "undo-b", 1), entry("k2", "undo-b", 2), entry("k3", "undo-c", 3)],
  };

  it("is the visit on the side path of the newest open entry its action undoes, when the side path owes it", () => {
    expect(isOwedUndo(stateOf(owing), node("undo-b"))).toBe(true);
  });

  it("is not one the side path does not owe, an entry that is not open, or an action that undoes none", () => {
    const notOwed = { ...owing, sidePath: { ...owing.sidePath, owed: ["k1"] } };
    const closed = {
      ...owing,
      compensations: [entry("k1", "undo-b", 1), entry("k2", "undo-b", 2, "closed")],
      sidePath: { ...owing.sidePath, owed: ["k2"] },
    };

    expect(isOwedUndo(stateOf(notOwed), node("undo-b"))).toBe(false);
    expect(isOwedUndo(stateOf(closed), node("undo-b"))).toBe(false);
    expect(
      isOwedUndo(
        stateOf({ ...owing, sidePath: { ...owing.sidePath, next: "undo-c" } }),
        node("undo-c"),
      ),
    ).toBe(false);
  });

  it("is not one off the side path, whatever entries are open", () => {
    expect(isOwedUndo(stateOf({ ...owing, sidePath: null }), node("undo-b"))).toBe(false);
    expect(isOwedUndo(stateOf(owing), node("undo-c"))).toBe(false);
  });
});
