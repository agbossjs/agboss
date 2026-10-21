import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_LIMITS, resolveAgentLimits } from "../../../src/graph/agent-loop/index.js";
import { BudgetExceededError, LimitExceededError } from "../../../src/graph/limits.js";
import { replyWith, callTools, harness, read, runLoop, startInput } from "./fixtures.js";

describe("AC7: limits per call of the agent — modelCalls and toolCalls", () => {
  it("defaults are 12 model calls and 20 tool calls, marked as defaults", () => {
    expect(DEFAULT_AGENT_LIMITS).toEqual({ modelCalls: 12, toolCalls: 20 });
    expect(resolveAgentLimits(undefined, undefined)).toEqual({
      limits: { modelCalls: 12, toolCalls: 20 },
      defaulted: ["modelCalls", "toolCalls"],
    });
  });

  it("maxToolCalls from the config still applies: the agent's own, then defaults.tools.maxToolCalls", () => {
    expect(resolveAgentLimits(undefined, 8)).toEqual({
      limits: { modelCalls: 12, toolCalls: 8 },
      defaulted: ["modelCalls"],
    });
    expect(resolveAgentLimits(2, 8).limits.toolCalls).toBe(2);
  });

  it("toolCalls hit exactly at the last allowed call is allowed", async () => {
    const h = harness({
      moves: [callTools(read("a", "a.ts")), callTools(read("b", "b.ts")), replyWith("ok")],
      limits: { toolCalls: 2 },
    });

    expect(await runLoop(h.graph, startInput(), "t")).toEqual({ kind: "answered", reply: "ok" });
  });

  it("one call more fails the run with agents.<name>.limits.toolCalls, carrying the loop's spend; the call does not run", async () => {
    const h = harness({
      moves: [callTools(read("a", "a.ts")), callTools(read("b", "b.ts"), read("c", "c.ts"))],
      limits: { toolCalls: 2 },
    });

    const failure = await runLoop(h.graph, startInput(), "t").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LimitExceededError);
    expect(failure).toMatchObject({
      key: "agents.coder.limits.toolCalls",
      limit: 2,
      actual: 3,
      path: ["chat-workflow-start", "main-router", "coder"],
    });
    expect((failure as LimitExceededError).usage).toHaveLength(2);
    expect(h.effects).toEqual(["read a.ts"]);
  });

  it("modelCalls: the call past the limit is never made; the run fails with agents.<name>.limits.modelCalls", async () => {
    const h = harness({
      moves: [callTools(read("a", "a.ts")), callTools(read("b", "b.ts")), replyWith("never")],
      limits: { modelCalls: 2 },
    });

    const failure = runLoop(h.graph, startInput(), "t");

    await expect(failure).rejects.toMatchObject({
      key: "agents.coder.limits.modelCalls",
      limit: 2,
      actual: 3,
    });
    expect(h.modelCalls).toEqual([0, 1]);
  });

  it("an execution budget already spent fails the loop before its model call", async () => {
    const h = harness({ moves: [replyWith("never")], executionBudget: 0 });

    const end = runLoop(h.graph, startInput(), "t");

    await expect(end).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(end).rejects.toMatchObject({
      budget: { name: "test-execution-budget" },
      key: "test-execution",
    });
    expect(h.modelCalls).toEqual([]);
  });

  it("a call that exhausts the budget runs none of its tools (#338): the error carries its cost", async () => {
    // one call costs $0.00042 (100 input tokens at $3/M, 20 output at $6/M)
    const h = harness({
      moves: [callTools(read("a", "a.ts")), replyWith("never")],
      executionBudget: 0.0004,
    });

    const failure = await runLoop(h.graph, startInput(), "t").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BudgetExceededError);
    expect((failure as BudgetExceededError).usage).toHaveLength(1);
    expect(h.effects).toEqual([]);
    expect(h.modelCalls).toEqual([0]);
  });
});
