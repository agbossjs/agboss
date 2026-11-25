import { describe, expect, it } from "vitest";
import { type AgentsConfigOf } from "../../src/config/types.js";
import { TokenLimit } from "../../src/config/types.js";
import { checkModelUses, resolutionProblems } from "../../src/models/check.js";
import { secret } from "../../src/environments/secret.js";
import { seconds } from "../../src/units/index.js";
import {
  DecisionsDriver,
  ModelCost,
  ModelProvider,
  CachedPart,
  CacheRetention,
  PromptCaching,
  Reasoning,
  ReasoningEffort,
} from "../../src/models/index.js";
import { ModelProviderDirectory } from "../../src/models/resolve.js";
import { ModelKind } from "../../src/models/model-kind.js";
import { modelUsesOf } from "../../src/models/uses.js";
import { LocalModelProvider, TestOpenRouterProvider } from "./providers.fixture.js";
import { CLAUDE_ENTRY, GPT5_ENTRY, KIMI_ENTRY, providerStub } from "./stub.js";

/** A decisions gateway that lists its models (`knownModels`): any other is `[model.unknown-model]`. */
@ModelProvider({
  name: "decisions-model-provider",
  description: "Decision models on a decisions gateway",
  driver: DecisionsDriver({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: secret("OPENROUTER_API_KEY"),
    knownModels: ["typesafe/jev-1.13"],
  }),
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
})
class ListingDecisionsProvider {}

/** A fresh directory: each provider instance fetches its model list once. */
const directoryOf = () =>
  ModelProviderDirectory.of([TestOpenRouterProvider, ListingDecisionsProvider, LocalModelProvider]);
/** The names the cascade resolves to: each use names its provider (#1313; no `serves` patterns pick one). */
const OPENROUTER = "openrouter-model-provider";
const LOCAL = "local-model-provider";
const DECISIONS = "decisions-model-provider";
/** What each provider's driver speaks: how a use's protocol is told (no model name does). */
const KINDS = new Map([[DECISIONS, ModelKind.Decisions]]);
const models = [
  KIMI_ENTRY,
  CLAUDE_ENTRY,
  GPT5_ENTRY,
  { id: "local/qwen" },
  { id: "local/llama" },
  { id: "backup/kimi-k2.6" },
];

const config = (agents: AgentsConfigOf<string>["agents"]): AgentsConfigOf<string> => ({
  name: "check",
  version: "1",
  defaults: {
    models: { temperature: 0, maxTokens: 1000 },
    router: { kind: "jev", model: "typesafe/jev-1.13", modelProvider: DECISIONS },
    tools: { maxToolCalls: 1 },
    uncompactedTurns: 1,
  },
  agents,
});

const problemsOf = async (
  agents: AgentsConfigOf<string>["agents"],
  routers = [{ name: "main", model: "typesafe/jev-1.13", modelProvider: DECISIONS }],
) =>
  checkModelUses(modelUsesOf(config(agents), routers, {}, KINDS), directoryOf(), {
    env: {},
    send: providerStub([], models).fetch,
  });

describe("AC6: fail fast — settings must fit their models, all problems at once", () => {
  it("AC6: settings that fit their models pass", async () => {
    expect(
      await problemsOf({
        scout: {
          model: "moonshotai/kimi-k2.6",
          modelProvider: OPENROUTER,
          description: "s",
          thinking: "none",
        },
        writer: {
          model: "anthropic/claude-sonnet-4.5",
          modelProvider: OPENROUTER,
          description: "w",
          thinking: { budgetTokens: 2000 },
        },
        local: {
          model: "local/llama",
          modelProvider: LOCAL,
          description: "l",
          maxTokens: TokenLimit.ModelMax,
        },
      }),
    ).toEqual([]);
  });

  it("AC6: every mismatch is reported at once, with key, value, model and what it supports", async () => {
    const problems = await problemsOf(
      {
        scout: {
          model: "moonshotai/kimi-k2.6",
          modelProvider: OPENROUTER,
          description: "s",
          thinking: Reasoning.on({ effort: ReasoningEffort.High, budget: { tokens: 4000 } }),
        },
        writer: {
          model: "openai/gpt-5",
          modelProvider: OPENROUTER,
          description: "w",
          thinking: "none",
        },
        reviewer: {
          model: "anthropic/claude-sonnet-4.5",
          modelProvider: OPENROUTER,
          description: "r",
          cache: PromptCaching.on({
            retention: CacheRetention.OneDay,
            cachedParts: [CachedPart.History],
          }),
        },
        ghost: { model: "nobody/listed", modelProvider: OPENROUTER, description: "g" },
        cheap: { model: "local/qwen", modelProvider: LOCAL, description: "c" },
      },
      [{ name: "main", model: "typesafe/jev-1.4", modelProvider: DECISIONS }],
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
        // its fallback is checked for the model it would be asked for (#1313)
        code: "model.unknown-model",
        key: "agents.ghost",
        value: "nobody/listed",
        model: "nobody/listed",
        supported: "backup-model-provider does not list it",
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
      writer: {
        model: "openai/gpt-5",
        modelProvider: OPENROUTER,
        description: "w",
        temperature: 0,
        thinking: "xhigh",
      },
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
            modelProvider: OPENROUTER,
            description: "p",
            thinking: "low",
            cache: PromptCaching.on({
              retention: CacheRetention.OneDay,
              cachedParts: [CachedPart.Tools],
            }),
          },
        }),
        [],
        {},
        KINDS,
      ),
      directoryOf(),
      { env: {}, send: providerStub([], [noReasoning]).fetch },
    );

    expect(problems.map((p) => [p.key, p.supported])).toEqual([
      ["agents.plain.thinking", "no reasoning"],
    ]);
  });

  it("AC6: a use with no provider, an unlisted one or one of the wrong protocol is found without asking any provider", () => {
    const onlyLocal = ModelProviderDirectory.of([LocalModelProvider]);
    const uses = modelUsesOf(
      config({
        a: { model: "x/y", description: "a" },
        b: { model: "x/y", modelProvider: OPENROUTER, description: "b" },
        c: { model: "x/y", modelProvider: DECISIONS, description: "c" },
      }),
      [],
    );

    expect(resolutionProblems(uses, onlyLocal).map((p) => [p.code, p.key])).toEqual([
      ["model.missing-provider", "agents.a"],
      ["model.missing-provider", "agents.b"],
      ["model.missing-provider", "agents.c"],
      ["model.missing-provider", "defaults.router"],
    ]);
    const listed = ModelProviderDirectory.of([TestOpenRouterProvider, ListingDecisionsProvider]);
    expect(
      resolutionProblems(uses, listed)
        .filter((p) => p.code === "model.incompatible-provider")
        .map((p) => [p.key, p.supported]),
    ).toEqual([["agents.c", `${DECISIONS} does not serve chat models`]]);
  });
});
