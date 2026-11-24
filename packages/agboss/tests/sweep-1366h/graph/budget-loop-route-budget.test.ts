import { argsDigestOf } from "../../../src/graph/agent-loop/move-entries.js";
import { usd } from "../../../src/units/index.js";
/**
 * #1366 (budget-loop shard): a tool task of the loop carries the budget the tool's own paid file reading is
 * checked against — the whole usage so far, the flow's path and the loop's own spend — so that a tool result's
 * files are never read past a budget the step has already used up.
 */
import { AIMessage } from "@langchain/core/messages";
import { Send } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { routeToActions } from "../../../src/graph/agent-loop/boundary.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

describe("#1366: the budget a tool task is handed", () => {
  it("every task of a move gets the usage so far, the flow's path and only what this loop spent", () => {
    const before = record(0.25, "before the loop");
    const inLoop = record(0.5, "in the loop");
    const state = {
      move: new AIMessage({
        content: "",
        tool_calls: [
          { id: "c1", name: "a", args: {}, type: "tool_call" },
          { id: "c2", name: "b", args: {}, type: "tool_call" },
        ],
      }),
      results: {},
      decisions: {},
      questionAnswers: {},
      prepared: {
        c1: {
          kind: "ready",
          args: {},
          shown: {},
          from: "model",
          tool: "a",
          argsDigest: argsDigestOf({}),
        },
        c2: {
          kind: "ready",
          args: {},
          shown: {},
          from: "model",
          tool: "b",
          argsDigest: argsDigestOf({}),
        },
      },
      usage: [before, inLoop],
      from: { usage: 1 },
      flowPath: ["flow", "alpha"],
      runId: "r",
      fileTally: { count: 0, bytes: 0 },
      fileTranscripts: {},
    };

    const routed = routeToActions({ agent: { name: "alpha", tools: [] } } as never)(state as never);

    expect(Array.isArray(routed)).toBe(true);
    const sends = routed as Send[];
    expect(sends).toHaveLength(2);
    for (const send of sends) {
      expect((send.args as { budget: unknown }).budget).toEqual({
        usage: [before, inLoop],
        path: ["flow", "alpha"],
        loop: [inLoop],
      });
    }
  });
});
