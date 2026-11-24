/**
 * #1295c (budget-loop shard) — the node that prepares the calls of a move before any approval, each rule on its own
 * over fakes: what a question's invalid ask says (every issue by its path and reason, no value) and that it asks
 * nobody, what the PII search and a hook's reported usage cost is the loop's spend, the tokens it made are kept, and
 * a hook's reported remote execution is kept with the call.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { usd } from "../../src/units/index.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { makePrepareNode } from "../../src/graph/agent-loop/prepare-node.js";
import { ToolCallDecision } from "../../src/tool-interceptors/decision.js";
import { PreparedFrom } from "../../src/graph/agent-loop/state.js";

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const stateOf = (name: string, args: Record<string, unknown>, changes: object = {}) =>
  ({
    runId: "run-1",
    move: new AIMessage({
      content: "",
      tool_calls: [{ id: "c1", name, args, type: "tool_call" }],
    }),
    results: {},
    decisions: {},
    prepared: {},
    piiTokens: {},
    piiValues: [],
    piiKey: null,
    ...changes,
  }) as never;

const tally = vi.fn((records: readonly UsageRecord[]) => records);
const budgets = { exhausted: new AbortController().signal, tally, remaining: () => 5 };

const askTool = (issues: { path: (string | number)[]; message: string }[]) => ({
  name: "ask-tool",
  timeout: 30_000,
  question: {},
  input: {
    safeParse: () => ({ success: false, error: { issues } }),
  },
});

describe("#1295c: a question's arguments", () => {
  it("that are no valid ask ask nobody: every issue named by its path and its reason, in order, no value", async () => {
    const tool = askTool([
      { path: ["q"], message: "Required" },
      { path: ["to", 0], message: "Expected string" },
    ]);
    const node = makePrepareNode({ agent: { name: "alpha", tools: [tool] }, budgets } as never);

    const out = await node(stateOf("ask-tool", { secret: "x" }), undefined);

    expect(out.questionAnswers).toEqual({
      c1: { tool: "ask-tool", problem: "invalid input: q: Required; to[0]: Expected string" },
    });
    expect(out.prepared).toMatchObject({ c1: { kind: "invalid", from: PreparedFrom.Model } });
    expect(out.usage).toEqual([]);
  });
});

describe("#1295c: what preparing spends", () => {
  const tool = {
    name: "write-tool",
    timeout: 30_000,
    input: { safeParse: (args: unknown) => ({ success: true, data: args }) },
  };

  it("the search of the arguments is the loop's spend, and the tokens it made are kept", async () => {
    const set = {
      isEmpty: false,
      withValues: () => set,
      withFieldKey: () => set,
      mask: (text: string) =>
        Promise.resolve({
          masked: { text: `<${text}>`, blocked: [], tokens: { [`<${text}>`]: text } },
          usage: [record(0.125, "detect")],
        }),
      refusalError: () => Promise.resolve(undefined),
    };
    const node = makePrepareNode({
      agent: { name: "alpha", tools: [tool] },
      budgets,
      pii: set,
    } as never);

    const out = await node(stateOf("write-tool", { to: "a" }), undefined);

    expect(out.usage).toEqual([record(0.125, "detect")]);
    expect(out.piiTokens).toEqual({ "<a>": "a" });
    expect(out.prepared).toMatchObject({
      c1: { kind: "ready", shown: { to: "<a>" }, args: { to: "a" } },
    });
  });

  it("a call through a hook chain is ready as the model's and spends nothing of its own", async () => {
    const instance = {
      beforeAnyTool: () => ToolCallDecision.allow(),
    };
    const chain = { name: "gate", instance, toolType: undefined, beforeMethod: undefined };
    const node = makePrepareNode({
      agent: { name: "alpha", tools: [tool] },
      budgets,
      interceptors: () => [chain],
    } as never);

    const out = await node(stateOf("write-tool", { to: "a" }), undefined);

    expect(out.prepared).toMatchObject({ c1: { kind: "ready", from: PreparedFrom.Model } });
    expect(out.usage).toEqual([]);
  });

  it("a call with a stored result is left alone", async () => {
    const node = makePrepareNode({ agent: { name: "alpha", tools: [tool] }, budgets } as never);

    const out = await node(
      stateOf("write-tool", { to: "a" }, { results: { c1: { callId: "c1" } } }),
      undefined,
    );

    expect(out.prepared).toEqual({});
  });
});
