import { describe, expect, it } from "vitest";
import { type AgentsConfigOf } from "../../src/config/types.js";
import { TokenLimit } from "../../src/config/types.js";
import { checkModelUses, resolutionProblems } from "../../src/models/check.js";
import {
  CachedPart,
  CacheRetention,
  DecisionsModelProvider,
  ModelProviderDirectory,
  PromptCaching,
  Reasoning,
  ReasoningEffort,
} from "../../src/models/index.js";
import { modelUsesOf } from "../../src/models/uses.js";
import { LocalModelProvider, TestOpenRouterProvider } from "./providers.fixture.js";
import { CLAUDE_ENTRY, GPT5_ENTRY, KIMI_ENTRY, providerStub } from "./stub.js";

/** A fresh directory: each provider instance fetches its model list once. */
const directoryOf = () =>
  ModelProviderDirectory.of([TestOpenRouterProvider, DecisionsModelProvider, LocalModelProvider]);
const models = [KIMI_ENTRY, CLAUDE_ENTRY, GPT5_ENTRY, { id: "local/qwen" }, { id: "local/llama" }];

const config = (agents: AgentsConfigOf<string>["agents"]): AgentsConfigOf<string> => ({
  name: "check",
  version: "1",
  defaults: {
    models: { temperature: 0, maxTokens: 1000 },
    router: { kind: "jev", model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 1 },
    uncompactedTurns: 1,
  },
  agents,
});

const problemsOf = async (
  agents: AgentsConfigOf<string>["agents"],
  routers = [{ name: "main", model: "typesafe/jev-1.13" }],
) =>
  checkModelUses(modelUsesOf(config(agents), routers), directoryOf(), {
    env: {},
    send: providerStub([], models).fetch,
  });

describe("AC6: fail fast — settings must fit their models, all problems at once", () => {
  it("AC6: settings that fit their models pass", async () => {
    expect(
      await problemsOf({
        scout: { model: "moonshotai/kimi-k2.6", description: "s", thinking: "none" },
        writer: {
          model: "anthropic/claude-sonnet-4.5",
          description: "w",
          thinking: { budgetTokens: 2000 },
        },
        local: { model: "local/llama", description: "l", maxTokens: TokenLimit.MODEL_MAX },
      }),
    ).toEqual([]);
  });

  it("AC6: every mismatch is reported at once, with key, value, model and what it supports", async () => {
    const problems = await problemsOf(
      {
        scout: {
          model: "moonshotai/kimi-k2.6",
          description: "s",
          thinking: Reasoning.on({ effort: ReasoningEffort.High, budget: { tokens: 4000 } }),
        },
        writer: { model: "openai/gpt-5", description: "w", thinking: "none" },
        reviewer: {
          model: "anthropic/claude-sonnet-4.5",
          description: "r",
          cache: PromptCaching.whereSupported({
            retention: CacheRetention.OneDay,
            cachedParts: [CachedPart.History],
          }),
        },
        ghost: { model: "nobody/listed", description: "g" },
        cheap: { model: "local/qwen", description: "c" },
      },
      [{ name: "main", model: "typesafe/jev-1.4" }],
    );

    expect(problems).toEqual([
      {
        code: "model.unsupported-setting",
        key: "agents.scout.thinking",
        value: "on(effort high, budget 4000 tokens)",
        model: "moonshotai/kimi-k2.6",
        supported: "efforts minimal, low, medium, high, xhigh; budget yes; effort with budget no",
      },
      {
        code: "model.unsupported-setting",
        key: "agents.writer.thinking",
        value: "off",
        model: "openai/gpt-5",
        supported: "reasoning is mandatory, it cannot be turned off",
      },
      {
        code: "model.unsupported-setting",
        key: "agents.writer.temperature",
        value: "0",
        model: "openai/gpt-5",
        supported: "parameters max_tokens, reasoning",
      },
      {
        code: "model.unsupported-setting",
        key: "agents.reviewer.cache.retention",
        value: "24h",
        model: "anthropic/claude-sonnet-4.5",
        supported: "retention 5m, 1h",
      },
      {
        code: "model.unknown-model",
        key: "agents.ghost",
        value: "nobody/listed",
        model: "nobody/listed",
        supported: "openrouter-model-provider does not list it",
      },
      {
        code: "model.no-price",
        key: "agents.cheap",
        value: "local/qwen",
        model: "local/qwen",
        supported: "local-model-provider prices only local/llama",
      },
      {
        code: "model.unknown-model",
        key: "routers.main",
        value: "typesafe/jev-1.4",
        model: "typesafe/jev-1.4",
        supported: "decisions-model-provider does not list it",
      },
    ]);
  });

  it("AC6: nothing is substituted — an effort the model lacks is a problem, not the nearest effort", async () => {
    const problems = await problemsOf({
      writer: { model: "openai/gpt-5", description: "w", temperature: 0, thinking: "xhigh" },
    });

    expect(problems.find((p) => p.key === "agents.writer.thinking")).toMatchObject({
      value: "on(effort xhigh)",
      supported: "efforts high, medium, low, minimal; budget yes; effort with budget no",
    });
  });

  it("AC6: a model without reasoning cannot be asked to reason; caching where unsupported is simply none", async () => {
    const noReasoning = {
      id: "plain/model",
      supported_parameters: ["temperature", "max_tokens"],
      pricing: {},
    };
    const problems = await checkModelUses(
      modelUsesOf(
        config({
          plain: {
            model: "plain/model",
            description: "p",
            thinking: "low",
            cache: PromptCaching.whereSupported({
              retention: CacheRetention.OneDay,
              cachedParts: [CachedPart.Tools],
            }),
          },
        }),
        [],
      ),
      directoryOf(),
      { env: {}, send: providerStub([], [noReasoning]).fetch },
    );

    expect(problems.map((p) => [p.key, p.supported])).toEqual([
      ["agents.plain.thinking", "no reasoning"],
    ]);
  });

  it("AC6: none and several providers are found without asking any provider", () => {
    const onlyLocal = ModelProviderDirectory.of([LocalModelProvider]);

    expect(
      resolutionProblems(
        modelUsesOf(config({ a: { model: "x/y", description: "a" } }), []),
        onlyLocal,
      ).map((p) => [p.code, p.key]),
    ).toEqual([
      ["model.unserved", "agents.a"],
      ["model.unserved", "defaults.router"],
    ]);
  });
});
