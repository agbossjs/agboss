import { usd } from "../../src/units/index.js";
/**
 * #1366: the spend of the agent's model boundary — what the check of a final answer cost is kept whether the answer
 * is taken or is invalid (a token nobody gave the model), so the ledger holds every paid detection.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { outgoingMove } from "../../src/graph/agent-loop/model-pii.js";
import { DetectionMode } from "../../src/pii/runtime-policy.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

/** A policy set whose every search costs `check`, and that refuses nothing. */
const setCosting = (check: UsageRecord) => {
  const searched: DetectionMode[] = [];
  const set = {
    mask: (text: string, _known: unknown, mode: DetectionMode) => {
      searched.push(mode);
      return Promise.resolve({
        masked: { text, blocked: [] },
        usage: [check],
      });
    },
    refusalError: () => Promise.resolve(undefined),
  };
  return { set, searched };
};

function runOf(content: string, check: UsageRecord) {
  const { set, searched } = setCosting(check);
  const pii = { withValues: () => ({ withFieldKey: () => set }) };
  const deps = { pii, agent: { name: "alpha", answerTools: { tools: [] } } };
  const state = {
    piiTokens: {},
    piiValues: [],
    piiKey: null,
    invalidAnswers: 0,
    usage: [],
    from: { usage: 0 },
  };
  const request = { messages: [], tokens: {}, cache: {}, blocked: [], usage: [] };
  const spent = [record(0.5, "call")];
  return {
    searched,
    spent,
    move: outgoingMove(new AIMessage({ content }), request, state as never, deps as never, spent),
  };
}

describe("#1366: what the check of the agent's answer cost", () => {
  it("an answer that is taken carries the cost of its check", async () => {
    const check = record(0.25, "check");
    const run = runOf("done", check);

    expect(await run.move).toMatchObject({ kind: "move", usage: [check] });
    expect(run.searched).toEqual([DetectionMode.WithModel]);
  });

  it("an invalid answer (a token nobody gave) keeps the spend of the call and of its check", async () => {
    const check = record(0.25, "check");
    const run = runOf("write to <email:7f3a91>", check);

    const moved = await run.move;

    expect(moved.kind).toBe("invalid");
    expect(moved.kind === "invalid" ? moved.update.usage : undefined).toEqual([
      ...run.spent,
      check,
    ]);
  });
});
