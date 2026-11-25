import { asDeclared } from "../src/models/model-pricing.js";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import { createModelRegistry, resolveSettings } from "../src/llm/registry.js";
import { PromptCaching, Reasoning, ReasoningEffort } from "../src/models/index.js";
import { fakeGateway, testConfig } from "./helpers.js";

describe("resolveSettings", () => {
  it("fills missing temperature, maxTokens and reasoning from defaults; caching on = the provider's", () => {
    const resolved = resolveSettings(testConfig.agents.alpha, testConfig.defaults.models);

    expect(resolved).toEqual({
      model: "test/alpha",
      temperature: 0,
      maxTokens: "max",
      reasoning: Reasoning.modelDecides(),
    });
  });

  it("keeps explicit values over defaults", () => {
    const resolved = resolveSettings(
      {
        ...testConfig.agents.alpha,
        temperature: 0.7,
        maxTokens: 50,
        thinking: "high",
        cache: false,
      },
      testConfig.defaults.models,
    );

    expect(resolved.temperature).toBe(0.7);
    expect(resolved.maxTokens).toBe(50);
    expect(resolved.reasoning).toEqual(Reasoning.on({ effort: ReasoningEffort.High }));
    expect(resolved.promptCaching).toEqual(PromptCaching.off());
  });
});

describe("createModelRegistry", () => {
  it("binds every configured agent", () => {
    const registry = createModelRegistry(
      testConfig,
      fakeGateway(() => new FakeListChatModel({ responses: [] })),
      asDeclared,
    );

    expect([...registry.agents.keys()]).toEqual(["alpha", "beta"]);
  });

  it("reuses one client for identical settings", () => {
    const factory = vi.fn(() => new FakeListChatModel({ responses: [] }));
    const config = {
      ...testConfig,
      agents: {
        alpha: testConfig.agents.alpha,
        beta: { ...testConfig.agents.beta, model: "test/alpha" },
      },
    };

    const registry = createModelRegistry(config, fakeGateway(factory), asDeclared);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.agents.get("alpha")?.model).toBe(registry.agents.get("beta")?.model);
  });
});
