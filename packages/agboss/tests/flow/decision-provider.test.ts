/**
 * A yes / no decision on a decision model (a guardrail's, a router's launch) goes to the provider its
 * cascade resolved: the call named none and failed `[model.missing-provider]` at run time when the
 * component's own provider is not the application's.
 */
import { describe, expect, it } from "vitest";
import { createLaunchDecider } from "../../src/flow/runtime/launch/launch-decider.js";
import type { DecideSpec } from "../../src/llm/gateway.js";
import { GuardrailSide } from "../../src/components/policy-decorators.js";
import { modelDecisionOf } from "../../src/guardrails/model-decision.js";
import type { LoadedModelGuardrail } from "../../src/guardrails/assembly.js";
import type { GuardrailRuntimeParts } from "../../src/guardrails/runtime.js";
import type { RouterModel } from "../../src/config/types.js";

const answered = {
  answers: { "launch-answer": { type: "boolean", probability: 0.9 } },
  usage: { caller: "x", model: "m", costUsd: 0 },
};

/** A gateway that records what each decision asked for. */
function recordingGateway(specs: DecideSpec[]) {
  return {
    decide: (spec: DecideSpec) => {
      specs.push(spec);
      const [question] = Object.keys(spec.request.questions);
      return Promise.resolve({
        answers: { [question ?? ""]: { type: "boolean", probability: 0.9 } },
        usage: answered.usage,
      });
    },
  };
}

const model: RouterModel = { kind: "jev", model: "decide-1", modelProvider: "decisions" };

describe("a decision model's provider reaches the gateway", () => {
  it("a router's launch decision names its provider", async () => {
    const specs: DecideSpec[] = [];
    const deps = { gateway: recordingGateway(specs) as never, chatDefaults: { temperature: 0 } };

    await createLaunchDecider("desk", model, deps).decide({
      input: "hi",
      instructions: "decide",
      questions: [{ target: "refunds", prompt: "refund?" }],
    });

    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ model: "decide-1", modelProvider: "decisions" });
  });

  it("a model guardrail's decision names the provider it resolved to", async () => {
    const specs: DecideSpec[] = [];
    const guardrail = {
      kind: "model",
      name: "rude",
      type: class {},
      side: GuardrailSide.Input,
      prompt: "Is it rude?",
      threshold: 0.5,
      model: "decide-1",
      modelProvider: "decisions",
      isOwnModel: true,
    } as unknown as LoadedModelGuardrail;
    const parts = {
      modelOf: () => model,
      deciderDeps: { gateway: recordingGateway(specs) as never, chatDefaults: { temperature: 0 } },
    } as unknown as GuardrailRuntimeParts;

    const decision = modelDecisionOf(guardrail, parts);
    await decision(
      { text: "you fool", component: { name: "agent" } as never, side: GuardrailSide.Input },
      [],
    );

    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ caller: "guardrail:rude", modelProvider: "decisions" });
  });
});
