import { describe, expect, it } from "vitest";
import { QuorumKind } from "../../../src/flow/ast.js";
import {
  QuorumState,
  quorumOutcomeOf,
  quorumRuleOf,
} from "../../../src/flow/runtime/launch/quorum.js";
import { BranchStatus, BranchVerdict } from "../../../src/flow/runtime/launch/records.js";

/** #279 S26 — the quorum's state in the launch registry and its outcome from the records, alone. */

const count = (min: number, max?: number) =>
  quorumRuleOf(
    max === undefined ? { kind: QuorumKind.Count, min } : { kind: QuorumKind.Count, min, max },
    [],
  );

const groups = (...places: readonly { agents: readonly string[]; priority?: number }[]) =>
  quorumRuleOf({ kind: QuorumKind.Groups, groups: [] }, places);

const counted = (index: number, acceptedSequence: number) => ({
  launchId: "l",
  index,
  status: BranchStatus.Finished,
  read: [],
  verdict: BranchVerdict.Counted,
  acceptedSequence,
});

describe("QuorumState: .joinQuorum({ min, max })", () => {
  it("counts up to max, then surplus; max defaults to min", () => {
    const state = new QuorumState(count(2), ["a", "b", "c"]);

    expect(state.accept(0)).toEqual({ verdict: BranchVerdict.Counted, acceptedSequence: 1 });
    expect(state.isDecided()).toBe(false);
    expect(state.accept(2)).toEqual({ verdict: BranchVerdict.Counted, acceptedSequence: 2 });
    expect(state.isDecided()).toBe(true);
    expect(state.accept(1)).toEqual({ verdict: BranchVerdict.Surplus });
  });

  it("decided at once when min can no longer be reached", () => {
    const state = new QuorumState(count(2, 3), ["a", "b", "c"]);
    state.leave(0);

    expect(state.isDecided()).toBe(false);
    state.leave(1);
    expect(state.isDecided()).toBe(true);
  });

  it("closed by the deadline: nothing counts any more", () => {
    const state = new QuorumState(count(1, 3), ["a", "b"]);
    state.close();

    expect(state.isDecided()).toBe(true);
    expect(state.accept(0)).toEqual({ verdict: BranchVerdict.Surplus });
  });

  it("restored from records: counting goes on after the last sequence", () => {
    const state = new QuorumState(count(2, 3), ["a", "b", "c"]);
    state.restore(counted(2, 2));
    state.restore(counted(0, 1));

    expect(state.accept(1)).toEqual({ verdict: BranchVerdict.Counted, acceptedSequence: 3 });
  });
});

describe("groups: priority, ties, the outcome from the records", () => {
  it("equal priorities (none): the first completed wins", () => {
    const rule = groups({ agents: ["a"] }, { agents: ["b"] });
    const outcome = quorumOutcomeOf(rule, [counted(0, 2), counted(1, 1)], ["a", "b"]);

    expect(outcome).toMatchObject({ isReached: true, group: 1 });
    expect(outcome.counted.map((answer) => answer.node)).toEqual(["b"]);
  });

  it("a repeated agent needs that many copies, any of them", () => {
    const rule = groups({ agents: ["critic", "critic"], priority: 1 });
    const state = new QuorumState(rule, ["critic", "critic", "critic"]);
    state.accept(2);

    expect(state.isDecided()).toBe(false);
    state.accept(0);
    expect(state.isDecided()).toBe(true);
  });

  it("no group complete: not reached", () => {
    const rule = groups({ agents: ["a", "b"], priority: 1 });

    expect(quorumOutcomeOf(rule, [counted(0, 1)], ["a", "b"]).isReached).toBe(false);
  });
});
