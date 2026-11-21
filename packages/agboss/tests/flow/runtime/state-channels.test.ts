/**
 * #1366 (shard once-state) — the channels of an execution's state: what each starts as, and how a
 * node's update joins what the channel holds. The spend (`usage`, an append) and the counters (`steps`,
 * `visits`) are counted once across every pass of an execution only by these reducers.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_VALUES } from "../../../src/flow/context/context-values.js";
import { mergeCompensations } from "../../../src/flow/compensation.js";
import { mergeBranchRecords } from "../../../src/flow/runtime/launch/records.js";
import { ExecutionState } from "../../../src/flow/runtime/state.js";
import { mergeTokens } from "../../../src/pii/tokens.js";

interface Channel {
  readonly operator: (left: unknown, right: unknown) => unknown;
  readonly initialValueFactory: () => unknown;
}

const channels: Readonly<Record<string, Channel>> = ExecutionState.spec as never;
const channelOf = (name: string): Channel => {
  const found = channels[name];
  if (found === undefined) throw new Error(`no channel ${name}`);
  return found;
};

/** Channels whose update replaces what they hold: `[name, what a new execution holds]`. */
const REPLACED: readonly (readonly [string, unknown])[] = [
  ["runId", ""],
  ["start", ""],
  ["startInput", {}],
  ["startedVersion", ""],
  ["startedAt", ""],
  ["scope", {}],
  ["lastError", null],
  ["next", ""],
  ["finish", ""],
  ["output", undefined],
  ["budgetUsd", Number.POSITIVE_INFINITY],
  ["budgets", []],
  ["history", []],
  ["memory", {}],
  ["launch", null],
  ["piiKey", null],
  ["child", null],
  ["sidePath", null],
];

/** Channels whose update is added after what they hold: `[name]`, a new execution holds `[]`. */
const APPENDED = [
  "outdatedValues",
  "path",
  "usage",
  "launches",
  "approvals",
  "toolCalls",
  "stepRecords",
  "children",
  "handledErrors",
] as const;

describe("#1366: the channels of an execution's state", () => {
  it("has exactly the channels this table names", () => {
    const named = [
      ...REPLACED.map(([name]) => name),
      ...APPENDED,
      "contexts",
      "visits",
      "steps",
      "branchRecords",
      "piiTokens",
      "fileTranscripts",
      "compensations",
    ];

    expect(Object.keys(channels).toSorted()).toEqual(named.toSorted());
  });

  it.each(REPLACED)("%s starts as %j and the next write replaces it", (name, initial) => {
    const channel = channelOf(name);

    expect(channel.initialValueFactory()).toEqual(initial);
    expect(channel.operator("held", "written")).toBe("written");
    expect(channel.operator("held", undefined)).toBeUndefined();
  });

  it.each(APPENDED)("%s starts empty and an update is added after what it holds", (name) => {
    const channel = channelOf(name);
    const held = [{ id: 1 }];
    const written = [{ id: 2 }, { id: 3 }];

    expect(channel.initialValueFactory()).toEqual([]);
    expect(channel.operator(held, written)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(held).toEqual([{ id: 1 }]);
    expect(written).toEqual([{ id: 2 }, { id: 3 }]);
    expect(channel.operator([], [])).toEqual([]);
  });

  it("a new execution holds the default contexts, and the next write replaces them", () => {
    const channel = channelOf("contexts");

    expect(channel.initialValueFactory()).toBe(DEFAULT_CONTEXT_VALUES);
    expect(channel.operator("held", "written")).toBe("written");
  });

  it("steps start at 0 and a write adds its count to what the execution took", () => {
    const channel = channelOf("steps");

    expect(channel.initialValueFactory()).toBe(0);
    expect(channel.operator(3, 2)).toBe(5);
    expect(channel.operator(0, 0)).toBe(0);
  });

  it("visits start empty; a write adds each node's count to its own and leaves the others", () => {
    const channel = channelOf("visits");
    const held = { clerk: 2, judge: 1 };
    const written = { clerk: 1, writer: 4 };

    expect(channel.initialValueFactory()).toEqual({});
    expect(channel.operator(held, written)).toEqual({ clerk: 3, judge: 1, writer: 4 });
    expect(held).toEqual({ clerk: 2, judge: 1 });
    expect(written).toEqual({ clerk: 1, writer: 4 });
    expect(channel.operator({}, {})).toEqual({});
  });

  it("the file transcripts start empty and a write adds its keys over the held ones", () => {
    const channel = channelOf("fileTranscripts");

    expect(channel.initialValueFactory()).toEqual({});
    expect(channel.operator({ a: "1", b: "2" }, { b: "3", c: "4" })).toEqual({
      a: "1",
      b: "3",
      c: "4",
    });
  });

  it("the branch records, the PII tokens and the compensations join by their own merge", () => {
    expect(channelOf("branchRecords").operator).toBe(mergeBranchRecords);
    expect(channelOf("branchRecords").initialValueFactory()).toEqual([]);
    expect(channelOf("piiTokens").operator).toBe(mergeTokens);
    expect(channelOf("piiTokens").initialValueFactory()).toEqual({});
    expect(channelOf("compensations").operator).toBe(mergeCompensations);
    expect(channelOf("compensations").initialValueFactory()).toEqual([]);
  });

  it("every default is made anew: no two executions share a list or a record", () => {
    for (const name of Object.keys(channels)) {
      const first = channelOf(name).initialValueFactory();
      const second = channelOf(name).initialValueFactory();
      if (typeof first === "object" && first !== null && first !== DEFAULT_CONTEXT_VALUES)
        expect(second).not.toBe(first);
    }
  });
});
