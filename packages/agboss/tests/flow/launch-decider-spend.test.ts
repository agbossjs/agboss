/**
 * #1366: the spend of a model's yes/no decision (a router's launch, an arbiter's judgement) — a paid call is
 * recorded whether its answer is read or fails to parse, so the ledger holds what the model charged.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import {
  createLaunchDecider,
  type LaunchDeciderDeps,
} from "../../src/flow/runtime/launch/launch-decider.js";
import { LAUNCH_ANSWER_TOOL } from "../../src/prompts/router-launch.js";

const request = {
  input: "refund 5 EUR",
  instructions: "decide",
  questions: [{ target: "refunds", prompt: "is it a refund?" }],
};

/** A chat model whose one reply carries the cost the provider reported. */
function depsAnswering(args: Record<string, unknown>, cost: number): LaunchDeciderDeps {
  const reply = new AIMessage({
    content: "",
    tool_calls: [{ id: "c1", name: LAUNCH_ANSWER_TOOL, args }],
    response_metadata: { usage: { cost } },
  });
  const chat = { bindTools: () => ({ invoke: () => Promise.resolve(reply) }) };
  return {
    gateway: { chatModel: () => chat, routeTo: () => Promise.reject(new Error("unused")) } as never,
    chatDefaults: { temperature: 0 },
  };
}

const model = { kind: "llm" as const, model: "m" };

describe("#1366: what a chat model's yes/no decision cost", () => {
  it("an answer that is read carries the cost of the call", async () => {
    const decider = createLaunchDecider("desk", model, depsAnswering({ refunds: true }, 0.25));

    expect(await decider.decide(request)).toMatchObject({
      kind: "decided",
      launched: ["refunds"],
      usage: { costUsd: 0.25, caller: "router:desk" },
    });
  });

  it("an answer that fails to parse is a failure that still carries the cost of the paid call", async () => {
    const decider = createLaunchDecider("desk", model, depsAnswering({ refunds: "yes" }, 0.25));

    const outcome = await decider.decide(request);

    expect(outcome).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("is not true or false"),
      usage: { costUsd: 0.25, caller: "router:desk" },
    });
    expect(outcome).not.toHaveProperty("cause");
  });

  it("a call that broke before any reply has no cost to carry", async () => {
    const chat = {
      bindTools: () => ({ invoke: () => Promise.reject(new Error("503")) }),
    };
    const deps: LaunchDeciderDeps = {
      gateway: {
        chatModel: () => chat,
        routeTo: () => Promise.reject(new Error("unused")),
      } as never,
      chatDefaults: { temperature: 0 },
    };

    const outcome = await createLaunchDecider("desk", model, deps).decide(request);

    expect(outcome).toMatchObject({ kind: "failed", reason: "503" });
    expect(outcome).not.toHaveProperty("usage");
  });
});
