import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { ModelKind } from "../../src/models/index.js";
import { ModelProviderDirectory } from "../../src/models/resolve.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import {
  LocalMirrorModelProvider,
  LocalModelProvider,
  TestDecisionsProvider,
  TestOpenRouterProvider,
} from "./providers.fixture.js";

const chat = (model: string, modelProvider?: string) => ({
  key: "agents.scout",
  model,
  purpose: ModelKind.Chat,
  ...(modelProvider === undefined ? {} : { modelProvider }),
});

const providerOf = (directory: ModelProviderDirectory, query: ReturnType<typeof chat>) => {
  const resolution = directory.resolve(query);
  return resolution.kind === "resolved"
    ? resolution.provider.options.name
    : resolution.problem.code;
};

describe("which provider serves a model (the cascade names it, F2: no serves patterns)", () => {
  const directory = ModelProviderDirectory.of([
    TestOpenRouterProvider,
    TestDecisionsProvider,
    LocalModelProvider,
  ]);

  it("the provider the cascade names serves the model, whatever the model's name", () => {
    expect(providerOf(directory, chat("moonshotai/kimi-k2.6", "openrouter-model-provider"))).toBe(
      "openrouter-model-provider",
    );
    expect(providerOf(directory, chat("local/llama", "openrouter-model-provider"))).toBe(
      "openrouter-model-provider",
    );
    expect(
      providerOf(directory, {
        ...chat("typesafe/jev-1.13", "decisions-model-provider"),
        purpose: ModelKind.Decisions,
      }),
    ).toBe("decisions-model-provider");
  });

  it("no provider named → model.missing-provider, with the key and the listed providers", () => {
    expect(directory.resolve(chat("moonshotai/kimi-k2.6"))).toEqual({
      kind: "problem",
      problem: {
        code: "model.missing-provider",
        key: "agents.scout",
        value: "moonshotai/kimi-k2.6",
        model: "moonshotai/kimi-k2.6",
        supported:
          "no modelProvider is set for it — name one on the component, its workflow or its application (listed: openrouter-model-provider, decisions-model-provider, local-model-provider)",
      },
    });
  });

  it("a provider that is not listed is model.missing-provider; one of the other kind model.incompatible-provider", () => {
    expect(providerOf(directory, chat("a/b", "backup-model-provider"))).toBe(
      "model.missing-provider",
    );
    expect(providerOf(directory, chat("a/b", "decisions-model-provider"))).toBe(
      "model.incompatible-provider",
    );
  });

  it("two providers never tie: there is no routing by a model's name (the old model.ambiguous-provider is gone)", () => {
    const both = ModelProviderDirectory.of([LocalModelProvider, LocalMirrorModelProvider]);

    expect(providerOf(both, chat("local/llama"))).toBe("model.missing-provider");
    expect(providerOf(both, chat("local/llama", "local-mirror-model-provider"))).toBe(
      "local-mirror-model-provider",
    );
  });

  it("a plain class is not a provider", () => {
    expect(() => modelProviderOf(Date)).toThrow(ConfigError.ModelProvider);
    expect(() => modelProviderOf({})).toThrow("a value is not a @ModelProvider class");
  });
});
