import { describe, expect, it } from "vitest";
import {
  DECISION_MODELS,
  DecisionsModelProvider,
  ModelProvider,
  ModelProviderDirectory,
  ModelProviderError,
  ModelPurpose,
} from "../../src/models/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { DEFAULT_MODEL_PROVIDERS, directoryOf } from "../../src/models/workflow-models.js";
import {
  LocalMirrorModelProvider,
  LocalModelProvider,
  TestOpenRouterProvider,
} from "./providers.fixture.js";

const chat = (model: string) => ({ key: "agents.scout", model, purpose: ModelPurpose.Chat });

const providerOf = (directory: ModelProviderDirectory, query: ReturnType<typeof chat>) => {
  const resolution = directory.resolve(query);
  return resolution.kind === "resolved"
    ? resolution.provider.options.name
    : resolution.problem.code;
};

describe("AC6: which provider serves a model (serves patterns)", () => {
  const directory = ModelProviderDirectory.of([
    TestOpenRouterProvider,
    DecisionsModelProvider,
    LocalModelProvider,
  ]);

  it("AC6: exactly one provider serving the model for its purpose serves it", () => {
    expect(providerOf(directory, chat("moonshotai/kimi-k2.6"))).toBe("openrouter-model-provider");
    // OpenRouter serves /.*/ but has no decisions; Jev has no chat models
    expect(
      providerOf(directory, { ...chat("typesafe/jev-1.13"), purpose: ModelPurpose.Decision }),
    ).toBe("decisions-model-provider");
  });

  it("AC6: no provider → model.unserved, with the key and the listed providers", () => {
    const onlyLocal = ModelProviderDirectory.of([LocalModelProvider]);

    expect(onlyLocal.resolve(chat("moonshotai/kimi-k2.6"))).toEqual({
      kind: "problem",
      problem: {
        code: "model.unserved",
        key: "agents.scout",
        value: "moonshotai/kimi-k2.6",
        model: "moonshotai/kimi-k2.6",
        supported: "no listed provider serves it for chat (listed: local-model-provider)",
      },
    });
  });

  it("#266 AC2: several providers → model.ambiguous-provider — no default breaks the tie", () => {
    const both = ModelProviderDirectory.of([LocalModelProvider, LocalMirrorModelProvider]);

    expect(providerOf(both, chat("local/llama"))).toBe("model.ambiguous-provider");
  });

  it("AC6: the built-ins serve OpenRouter for chat and Jev for decisions", () => {
    const defaults = directoryOf(DEFAULT_MODEL_PROVIDERS);

    expect(providerOf(defaults, chat("test/alpha"))).toBe("openrouter-model-provider");
    expect(
      providerOf(defaults, { ...chat("typesafe/jev-1.13"), purpose: ModelPurpose.Decision }),
    ).toBe("decisions-model-provider");
    expect(providerOf(defaults, chat("typesafe/jev-1.13"))).toBe("model.unserved");
    // #226: every decision model, not only Jev, is the Decisions API's — none is a chat model
    for (const model of DECISION_MODELS) {
      expect(providerOf(defaults, { ...chat(model), purpose: ModelPurpose.Decision })).toBe(
        "decisions-model-provider",
      );
      expect(providerOf(defaults, chat(model))).toBe("model.unserved");
    }
  });

  it("AC6: a provider needs a serves pattern; a plain class is not a provider", () => {
    expect(() => ModelProvider({ ...modelProviderOf(LocalModelProvider), serves: [] })).toThrow(
      ModelProviderError,
    );
    expect(() => modelProviderOf(Date)).toThrow(ModelProviderError);
    expect(() => modelProviderOf({})).toThrow("a value is not a @ModelProvider class");
  });
});
