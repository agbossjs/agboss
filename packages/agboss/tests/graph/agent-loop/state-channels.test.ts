/**
 * #1366 (shard once-state) — the channels of one agent's loop: what each starts as, and how an update
 * joins what the channel holds. The loop's spend (`usage`) and its model and tool call counts are
 * added to, never replaced, so each call is counted once across the loop's resumed passes.
 */
import { describe, expect, it } from "vitest";
import { NO_FILES } from "../../../src/files/visit-files.js";
import { mergeTokens } from "../../../src/pii/tokens.js";
import {
  AgentLoopState,
  LOOP_NODE,
  loopProgressOf,
  loopUsage,
  type AgentLoopStateType,
} from "../../../src/graph/agent-loop/state.js";
import { recordToolCost } from "../../../src/finops/usage.js";

interface Channel {
  readonly operator: (left: unknown, right: unknown) => unknown;
  readonly initialValueFactory: () => unknown;
}

const channels: Readonly<Record<string, Channel>> = AgentLoopState.spec as never;
const channelOf = (name: string): Channel => {
  const found = channels[name];
  if (found === undefined) throw new Error(`no channel ${name}`);
  return found;
};

const REPLACED: readonly (readonly [string, unknown])[] = [
  ["runId", ""],
  ["history", []],
  ["summaries", []],
  ["inputMessage", ""],
  ["inputFiles", []],
  ["answerFiles", []],
  ["fileTally", NO_FILES],
  ["flowPath", []],
  ["from", { usage: 0, approvals: 0 }],
  ["move", null],
  ["reply", null],
  ["answer", null],
  ["answeredWith", []],
  ["piiValues", []],
  ["piiKey", null],
];

const APPENDED = [
  "usage",
  "approvals",
  "seen",
  "messages",
  "trajectory",
  "judgeVerdicts",
  "guardrailDecisions",
] as const;

const MERGED = [
  "fileTranscripts",
  "results",
  "decisions",
  "prepared",
  "questionAnswers",
  "callRecords",
  "piiMasked",
] as const;

const ADDED = ["modelCalls", "toolCalls", "retries", "invalidAnswers", "invalidArguments"] as const;

describe("#1366: the channels of an agent's loop", () => {
  it("has exactly the channels this table names", () => {
    const named = [
      ...REPLACED.map(([name]) => name),
      ...APPENDED,
      ...MERGED,
      ...ADDED,
      "piiTokens",
    ];

    expect(Object.keys(channels).toSorted()).toEqual(named.toSorted());
  });

  it.each(REPLACED)("%s starts as %j and the next write replaces it", (name, initial) => {
    const channel = channelOf(name);

    expect(channel.initialValueFactory()).toEqual(initial);
    expect(channel.operator("held", "written")).toBe("written");
    expect(channel.operator("held", null)).toBeNull();
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

  it.each(MERGED)("%s starts empty and a write's keys are put over the held ones", (name) => {
    const channel = channelOf(name);
    const held = { a: 1, b: 2 };
    const written = { b: 3, c: 4 };

    expect(channel.initialValueFactory()).toEqual({});
    expect(channel.operator(held, written)).toEqual({ a: 1, b: 3, c: 4 });
    expect(held).toEqual({ a: 1, b: 2 });
    expect(written).toEqual({ b: 3, c: 4 });
    expect(channel.operator({}, {})).toEqual({});
  });

  it.each(ADDED)("%s starts at 0 and a write is added to the count held", (name) => {
    const channel = channelOf(name);

    expect(channel.initialValueFactory()).toBe(0);
    expect(channel.operator(3, 2)).toBe(5);
    expect(channel.operator(0, 0)).toBe(0);
  });

  it("the PII tokens join by their own merge", () => {
    expect(channelOf("piiTokens").operator).toBe(mergeTokens);
    expect(channelOf("piiTokens").initialValueFactory()).toEqual({});
  });

  it("every default is made anew, but the files tally and the handed-over lengths", () => {
    const shared = new Set(["fileTally", "from"]);
    for (const name of Object.keys(channels)) {
      if (shared.has(name)) continue;
      const first = channelOf(name).initialValueFactory();
      if (typeof first === "object" && first !== null)
        expect(channelOf(name).initialValueFactory()).not.toBe(first);
    }
    expect(channelOf("fileTally").initialValueFactory()).toBe(NO_FILES);
  });
});

const stateOf = (changes: Partial<AgentLoopStateType>): AgentLoopStateType =>
  ({
    usage: [],
    from: { usage: 0, approvals: 0 },
    modelCalls: 0,
    invalidAnswers: 0,
    invalidArguments: 0,
    ...changes,
  }) as AgentLoopStateType;

describe("#1366: what a loop spent, and how far it is", () => {
  it("loopUsage is what the loop spent past what the flow handed it", () => {
    const [flow, first, second] = [
      recordToolCost("flow", 1),
      recordToolCost("a", 2),
      recordToolCost("b", 3),
    ];
    const usage = [flow, first, second];

    expect(loopUsage(stateOf({ usage, from: { usage: 1, approvals: 0 } }))).toEqual([
      first,
      second,
    ]);
    expect(loopUsage(stateOf({ usage, from: { usage: 0, approvals: 0 } }))).toEqual(usage);
    expect(loopUsage(stateOf({ usage, from: { usage: 3, approvals: 0 } }))).toEqual([]);
  });

  it("loopProgressOf counts the model calls plus the one about to be made, and the invalid ones", () => {
    const state = stateOf({ modelCalls: 2, invalidAnswers: 1, invalidArguments: 4 });

    expect(loopProgressOf(state)).toEqual({ toolLoopIteration: 2, validationAttempts: 5 });
    expect(loopProgressOf(state, 1)).toEqual({ toolLoopIteration: 3, validationAttempts: 5 });
  });

  it("names the nodes of the loop", () => {
    expect(LOOP_NODE).toEqual({
      input: "input",
      model: "model",
      boundary: "boundary",
      prepare: "prepare",
      approval: "approval",
      tool: "tool",
      collect: "collect",
      reply: "agent-reply",
      answer: "agent-answer",
      judge: "judge",
    });
  });
});
