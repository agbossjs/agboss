/**
 * #1366: the quorum step readers refuse malformed arguments with a FlowSyntaxError and build frozen
 * quorums that carry only the options given (no key for a missing deadline / max / priority).
 */
import { describe, expect, it } from "vitest";
import {
  acceptedByOf,
  anyOf,
  countQuorumOf,
  groupsQuorumOf,
  priorityOf,
  quorumGroupOf,
} from "../../../src/flow/quorum-step.js";
import { FlowSyntaxError } from "../../../src/flow/launch-step.js";
import { QuorumKind, StepKind, type QuorumGroup, type Step } from "../../../src/flow/ast.js";

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

describe("#1366: anyOf and acceptedBy", () => {
  it("anyOf refuses a non-class among its arbiters", () => {
    expect(() => anyOf(ArbiterA as never, "x" as never)).toThrow(FlowSyntaxError);
    expect(() => (anyOf as (...a: unknown[]) => unknown)(ArbiterA)).toThrow(FlowSyntaxError);
    expect(anyOf(ArbiterA as never, ArbiterB as never).arbiters).toEqual([ArbiterA, ArbiterB]);
  });

  it("acceptedBy takes a class or an anyOf, refuses anything else", () => {
    expect(acceptedByOf(ArbiterA).arbiters).toEqual([ArbiterA]);
    const choice = anyOf(ArbiterA, ArbiterB);
    expect(acceptedByOf(choice).arbiters).toEqual([ArbiterA, ArbiterB]);
    expect(() => acceptedByOf({ arbiters: [ArbiterA, ArbiterB] })).toThrow(FlowSyntaxError);
    expect(() => acceptedByOf(null)).toThrow(FlowSyntaxError);
    expect(() => acceptedByOf(asArbiter(5))).toThrow(FlowSyntaxError);
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
  const g = (name: string, extra: object = {}): QuorumGroup =>
    ({ agents: [AgentX], returns: [], path: { steps: [] }, name, ...extra }) as never;
  const asGroup = (path: unknown): QuorumGroup | undefined =>
    typeof path === "object" && path !== null && "agents" in path ? (path as never) : undefined;

  it("takes every group, then the options", () => {
    const g1 = g("1");
    const g2 = g("2");
    const q = groupsQuorumOf([g1, g2, { deadline: 5000 }], asGroup);
    expect(q).toStrictEqual({ kind: QuorumKind.Groups, groups: [g1, g2], deadline: 5000 });
    expect(Object.isFrozen(q)).toBe(true);
  });

  it("without options it has no deadline key", () => {
    const g1 = g("1");
    const q = groupsQuorumOf([g1], asGroup);
    expect(Object.keys(q).sort()).toEqual(["groups", "kind"]);
    expect(q.groups).toEqual([g1]);
  });

  it("the last group is not read as options even when it carries option-like keys", () => {
    const last = g("last", { max: 1, min: 1, deadline: 7 });
    const q = groupsQuorumOf([g("1"), last], asGroup);
    expect(q.groups).toHaveLength(2);
    expect(Object.keys(q)).not.toContain("deadline");
  });

  it("refuses no groups, a non-group among them, min / max options", () => {
    expect(() => groupsQuorumOf([], asGroup)).toThrow(FlowSyntaxError);
    expect(() => groupsQuorumOf([{ deadline: 5 }], asGroup)).toThrow(FlowSyntaxError);
    expect(() => groupsQuorumOf([g("1"), "x", g("2")], asGroup)).toThrow(FlowSyntaxError);
    expect(() => groupsQuorumOf([g("1"), "x", { deadline: 5 }], asGroup)).toThrow(FlowSyntaxError);
    expect(() => groupsQuorumOf([g("1"), { max: 2 }], asGroup)).toThrow(FlowSyntaxError);
    expect(() => groupsQuorumOf([g("1"), { min: 2 }], asGroup)).toThrow(FlowSyntaxError);
  });

  it("a trailing argument that is neither a group nor an options object is never a raw TypeError", () => {
    const g1 = g("1");
    for (const junk of ["x", 5, null, undefined])
      expect(() => groupsQuorumOf([g1, junk], asGroup)).not.toThrow(TypeError);
  });

  it("a deadline is validated for groups as for counts", () => {
    expect(() => groupsQuorumOf([g("1"), { deadline: 0 }], asGroup)).toThrow(FlowSyntaxError);
  });
});

describe("#1366: group priority and the group's own steps", () => {
  it("priority is a positive integer", () => {
    expect(priorityOf(3)).toBe(3);
    for (const p of [0, -2, 1.5, "1", undefined])
      expect(() => priorityOf(p)).toThrow(FlowSyntaxError);
  });

  const to: Step = { kind: StepKind.To } as never;
  const start = { kind: "group" as const, agents: [AgentX] };

  it("the steps are the group's own path", () => {
    const group = quorumGroupOf(start, [to, to]);
    expect(group.path.steps).toEqual([to, to]);
  });

  it("a group without steps has an empty path", () => {
    expect(quorumGroupOf(start, []).path.steps).toEqual([]);
  });

  it("priority is carried only when given", () => {
    expect(Object.keys(quorumGroupOf(start, [])).sort()).toEqual(["agents", "path"]);
    expect(quorumGroupOf({ ...start, priority: 2 }, []).priority).toBe(2);
  });
});
