/**
 * #1366: the quorum step readers refuse malformed arguments with a FlowSyntaxError and build frozen
 * quorums that carry only the options given (no key for a missing deadline / max / priority).
 */
import { describe, expect, it } from "vitest";
import {
  arbitratedByOf,
  countQuorumOf,
  groupsQuorumOf,
  priorityOf,
  quorumGroupOf,
} from "../../../src/flow/quorum-step.js";
import { FlowSyntaxError } from "../../../src/flow/launch-step.js";
import { QuorumKind, StepKind, type Step } from "../../../src/flow/ast.js";

class ArbiterA {
  readonly marker = "ArbiterA";
}
class ArbiterB {
  readonly marker = "ArbiterB";
}
class AgentX {
  readonly marker = "AgentX";
}

const asArbiter = (c: unknown): never => c as never;

describe("#1366: arbitratedBy", () => {
  it("takes one class, refuses anything else — no anyOf, no list", () => {
    expect(arbitratedByOf(ArbiterA)).toBe(ArbiterA);
    expect(() => arbitratedByOf({ arbiters: [ArbiterA, ArbiterB] })).toThrow(FlowSyntaxError);
    expect(() => arbitratedByOf([ArbiterA, ArbiterB])).toThrow(FlowSyntaxError);
    expect(() => arbitratedByOf(null)).toThrow(FlowSyntaxError);
    expect(() => arbitratedByOf(asArbiter(5))).toThrow(FlowSyntaxError);
  });
});

describe("#1366: the count quorum", () => {
  it("options must be an object, null included", () => {
    expect(() => countQuorumOf(null)).toThrow(FlowSyntaxError);
    expect(() => countQuorumOf(2)).toThrow(FlowSyntaxError);
  });

  it("min must be a positive integer", () => {
    for (const min of [0, -1, 1.5, "2", undefined, NaN])
      expect(() => countQuorumOf({ min })).toThrow(FlowSyntaxError);
    expect(countQuorumOf({ min: 2 }).min).toBe(2);
  });

  it("a quorum carries no key for a max / deadline that was not given", () => {
    const bare = countQuorumOf({ min: 2 });
    expect(Object.keys(bare).sort()).toEqual(["kind", "min"]);
    expect(Object.isFrozen(bare)).toBe(true);
    const full = countQuorumOf({ min: 2, max: 3, deadline: 1000 });
    expect(full).toStrictEqual({ kind: QuorumKind.Count, min: 2, max: 3, deadline: 1000 });
  });

  it("a deadline that is not a number is refused", () => {
    expect(() => countQuorumOf({ min: 1, deadline: "5" })).toThrow(FlowSyntaxError);
    expect(() => countQuorumOf({ min: 1, deadline: Infinity })).toThrow(FlowSyntaxError);
  });
});

describe("#1366: the groups quorum", () => {
  it("is the join with its deadline and no group yet: .onGroup(…) adds them", () => {
    const q = groupsQuorumOf({ deadline: 5000 });
    expect(q).toStrictEqual({ kind: QuorumKind.Groups, groups: [], deadline: 5000 });
    expect(Object.isFrozen(q)).toBe(true);
    expect(Object.isFrozen(q.groups)).toBe(true);
  });

  it("without options it has no deadline key", () => {
    expect(Object.keys(groupsQuorumOf(undefined)).sort()).toEqual(["groups", "kind"]);
    expect(Object.keys(groupsQuorumOf({})).sort()).toEqual(["groups", "kind"]);
  });

  it("refuses options that are no object, min / max, a bad deadline", () => {
    for (const junk of ["x", 5, null]) expect(() => groupsQuorumOf(junk)).toThrow(FlowSyntaxError);
    expect(() => groupsQuorumOf({ max: 2 })).toThrow(FlowSyntaxError);
    expect(() => groupsQuorumOf({ min: 2 })).toThrow(FlowSyntaxError);
    expect(() => groupsQuorumOf({ deadline: 0 })).toThrow(FlowSyntaxError);
  });
});

describe("#1366: group priority and the group's own steps", () => {
  it("priority is a positive integer, or none", () => {
    expect(priorityOf({ priority: 3 })).toBe(3);
    expect(priorityOf(undefined)).toBeUndefined();
    expect(priorityOf({})).toBeUndefined();
    for (const p of [0, -2, 1.5, "1"])
      expect(() => priorityOf({ priority: p })).toThrow(FlowSyntaxError);
    expect(() => priorityOf("1")).toThrow(FlowSyntaxError);
    expect(() => priorityOf(null)).toThrow(FlowSyntaxError);
  });

  const path = { steps: [{ kind: StepKind.To } as Step] };

  it("the group's own path is the one given; its targets are as listed", () => {
    const group = quorumGroupOf([AgentX, AgentX], undefined, path);
    expect(group.path).toBe(path);
    expect(group.targets).toEqual([AgentX, AgentX]);
    expect(Object.isFrozen(group)).toBe(true);
  });

  it("priority is carried only when given", () => {
    expect(Object.keys(quorumGroupOf([AgentX], undefined, path)).sort()).toEqual([
      "path",
      "targets",
    ]);
    expect(quorumGroupOf([AgentX], { priority: 2 }, path).priority).toBe(2);
  });

  it("refuses no targets and anything but classes", () => {
    for (const targets of [[], "x", [AgentX, "y"], undefined])
      expect(() => quorumGroupOf(targets, undefined, path)).toThrow(FlowSyntaxError);
  });
});
