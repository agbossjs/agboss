import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import type { ResolvedModelSettings } from "../../src/config/types.js";
import { resolveSettings } from "../../src/llm/registry.js";
import { Reasoning, ReasoningEffort } from "../../src/models/index.js";
import { reasoningLabel, reasoningOfThinking } from "../../src/models/reasoning.js";
import { wireBodies } from "./gateway.js";
import { LocalModelProvider, TestOpenRouterProvider } from "./providers.fixture.js";

const kimi: ResolvedModelSettings = {
  model: "moonshotai/kimi-k2.6",
  modelProvider: "openrouter-model-provider",
  temperature: 0,
  maxTokens: 100,
};
const llama: ResolvedModelSettings = {
  model: "local/llama",
  modelProvider: "local-model-provider",
  temperature: 0,
  maxTokens: 100,
};

describe("AC6: reasoning — Reasoning.modelDecides() | on({ effort?, budget? }) | off()", () => {
  it("AC6: on needs an effort or a budget (both allowed); a budget is a positive whole number", () => {
    expect(() => Reasoning.on({})).toThrow(ConfigError.Reasoning);
    expect(() => Reasoning.on({ budget: { tokens: 0 } })).toThrow(ConfigError.Reasoning);
    expect(Reasoning.on({ effort: ReasoningEffort.High, budget: { tokens: 4000 } })).toEqual({
      kind: "on",
      effort: "high",
      budget: { tokens: 4000 },
    });
  });

  it("AC6: today's component thinking maps to a Reasoning without substitution", () => {
    expect(reasoningOfThinking("default")).toEqual(Reasoning.modelDecides());
    expect(reasoningOfThinking("none")).toEqual(Reasoning.off());
    expect(reasoningOfThinking("minimal")).toEqual(
      Reasoning.on({ effort: ReasoningEffort.Minimal }),
    );
    expect(reasoningOfThinking({ budgetTokens: 2000 })).toEqual(
      Reasoning.on({ budget: { tokens: 2000 } }),
    );
    expect(reasoningOfThinking(Reasoning.off())).toEqual(Reasoning.off());
    expect(
      reasoningLabel(Reasoning.on({ effort: ReasoningEffort.High, budget: { tokens: 4000 } })),
    ).toBe("on(effort high, budget 4000 tokens)");
  });

  it("AC6: unset on the component = the provider's; set on the component or the defaults = an override", () => {
    const defaults = { temperature: 0 };

    expect(resolveSettings({ model: "a/b" }, defaults).reasoning).toBeUndefined();
    expect(resolveSettings({ model: "a/b" }, { ...defaults, thinking: "low" }).reasoning).toEqual(
      Reasoning.on({ effort: ReasoningEffort.Low }),
    );
    expect(
      resolveSettings({ model: "a/b", thinking: "none" }, { ...defaults, thinking: "low" })
        .reasoning,
    ).toEqual(Reasoning.off());
  });

  it("AC6: the provider's value applies when the component sets none; the component's wins (OpenAI dialect)", async () => {
    const [fromProvider, overridden] = await wireBodies(
      [LocalModelProvider],
      [llama, { ...llama, reasoning: Reasoning.on({ effort: ReasoningEffort.High }) }],
    );

    expect(fromProvider?.reasoning_effort).toBe("none");
    expect(overridden?.reasoning_effort).toBe("high");
  });

  it("AC6: OpenRouter's dialect — reasoning.effort or reasoning.max_tokens, thoughts excluded; nothing when the model decides", async () => {
    const bodies = await wireBodies(
      [TestOpenRouterProvider],
      [
        kimi,
        { ...kimi, reasoning: Reasoning.on({ effort: ReasoningEffort.Low }) },
        { ...kimi, reasoning: Reasoning.on({ budget: { tokens: 2000 } }) },
        { ...kimi, reasoning: Reasoning.off() },
      ],
    );

    expect(bodies.map((body) => body.reasoning)).toEqual([
      undefined,
      { effort: "low", exclude: true },
      { max_tokens: 2000, exclude: true },
      { effort: "none", exclude: true },
    ]);
  });
});
