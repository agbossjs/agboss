/**
 * Bughunt 2026-11-25 #2 (regression), per kind of model use: each is priced by the provider its
 * cascade resolved, for its own model, keyed by both — a guardrail, an arbiter, a launch decider and a
 * router (they all take `routerModelOf`), a reply interpreter, a `detectWithModel` PII policy, the built-in
 * file transcriber and redactor, a model reranker and a `DecisionModel` decision. Before, only agents,
 * judges and compactions were: the others failed with a `ModelCostError` on a price-table provider, or
 * were billed at an agent's price for a model of the same name on another provider. Each record
 * prices as the table says, and a provider with no `cost` marks the use unpriced.
 */
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it } from "vitest";
import { repliesFor } from "../../src/app/parts.js";
import { detectionSettingsOf } from "../../src/app/pii-parts.js";
import type { AgentsConfigOf } from "../../src/config/types.js";
import { CostSource, recordUsage } from "../../src/finops/usage.js";
import { FileView } from "../../src/files/model-files.js";
import { chatModelSettingsOf, routerModelOf } from "../../src/graph/router-model.js";
import { createProviderGateway, type ModelGateway } from "../../src/llm/gateway.js";
import { createModelRegistry, rerankerBindingOf } from "../../src/llm/registry.js";
import {
  DecisionsDriver,
  ModelCost,
  ModelProvider,
  OpenAiCompatibleDriver,
} from "../../src/models/index.js";
import { modelPricingOf, directoryOf } from "../../src/models/workflow-models.js";
import { seconds, usd } from "../../src/units/index.js";
import { instanceCalls } from "./gateway.js";
import { providerStub } from "./stub.js";

@ModelProvider({
  name: "priced-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://priced.test/v1" }),
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "p/model": { inputPerMillion: usd(10), outputPerMillion: usd(20) },
  }),
})
class PricedProvider {}

/** Another provider that serves a model of the same name at another price. */
@ModelProvider({
  name: "other-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://other.test/v1" }),
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "p/model": { inputPerMillion: usd(1000), outputPerMillion: usd(2000) },
  }),
})
class OtherProvider {}

@ModelProvider({
  name: "bare-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://bare.test/v1" }),
  timeout: seconds(5),
})
class BareProvider {}

@ModelProvider({
  name: "priced-decisions-provider",
  driver: DecisionsDriver({ baseUrl: "http://decide.test/v1" }),
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "d/decide": { inputPerMillion: usd(10), outputPerMillion: usd(20) },
  }),
})
class PricedDecisionsProvider {}

const directory = directoryOf([
  PricedProvider,
  OtherProvider,
  BareProvider,
  PricedDecisionsProvider,
]);
const pricing = modelPricingOf(directory);
const PRICE = { inputPerMTok: 10, outputPerMTok: 20 };
/** 1M tokens in, 1M out: $10 + $20 at the priced table. */
const MILLION = { usage_metadata: { input_tokens: 1_000_000, output_tokens: 1_000_000 } };

const priced = { model: "p/model", modelProvider: "priced-model-provider" } as const;

/** An agent on the other provider whose model has the same name: its price must never leak. */
const config: AgentsConfigOf<string> = {
  name: "kinds-workflow",
  version: "1.0.0",
  defaults: { models: { temperature: 0 }, uncompactedTurns: 5 },
  agents: {
    "other-agent": {
      description: "Answers elsewhere",
      model: "p/model",
      modelProvider: "other-model-provider",
      price: { inputPerMTok: 1000, outputPerMTok: 2000 },
    },
  },
};

const fakeGateway = (): ModelGateway => ({
  chatModel: () => new FakeListChatModel({ responses: ["ok"] }),
  routeTo: () => Promise.reject(new Error("no route")),
});

describe("bughunt #2: each kind of model use is priced by its own provider and model", () => {
  it("a router, guardrail, arbiter or launch decider on a chat model (routerModelOf)", () => {
    const deps = {
      gateway: fakeGateway(),
      chatDefaults: { temperature: 0 },
      chatModelSettings: chatModelSettingsOf(pricing),
    };
    const model = routerModelOf("p/model", deps, "priced-model-provider");

    expect(model).toMatchObject({ kind: "llm", price: PRICE });
    expect(recordUsage("router:r", model as never, MILLION)).toMatchObject({
      costUsd: usd(30),
      costSource: CostSource.PriceTable,
      provider: "priced-model-provider",
    });
    expect(routerModelOf("b/model", deps, "bare-model-provider", true)).toMatchObject({
      unpriced: true,
    });
  });

  it("a reply interpreter", () => {
    const parts = repliesFor({} as never, config, fakeGateway(), pricing, {
      get: () => ({}) as never,
    });

    expect(parts.chatModelSettings("p/model", "priced-model-provider")).toMatchObject({
      price: PRICE,
    });
  });

  it("a detectWithModel PII policy", () => {
    const bundle = { pii: { detectors: [{ name: "names-pii-policy", ...priced }] } } as never;
    const settings = detectionSettingsOf(bundle, config, pricing, {
      policy: "names-pii-policy",
      model: "p/model",
    });

    expect(settings.price).toEqual(PRICE);
    expect(recordUsage("pii:names-pii-policy", settings, MILLION).costUsd).toBe(usd(30));
  });

  it("the built-in file transcriber and redactor: their own model on the agent's provider", () => {
    const files = {
      views: [FileView.Transcription, FileView.Redacted],
      transcriptionModel: "p/model",
      redactionModel: "p/model",
      transcriptionMaxTokens: 100,
    };
    const reader: AgentsConfigOf<string> = {
      ...config,
      agents: {
        "reader-agent": {
          description: "Reads files",
          model: "p/agent-model",
          modelProvider: "priced-model-provider",
          // the fields the built-in file models read; the rest of a policy is not theirs
          files: files as never,
        },
      },
    };
    const registry = createModelRegistry(reader, fakeGateway(), pricing);

    expect(registry.fileTranscribers.get("reader-agent")?.settings.price).toEqual(PRICE);
    expect(registry.fileRedactors.get("reader-agent")?.settings.price).toEqual(PRICE);
  });

  it("a model reranker, with its provider's unpriced mark", () => {
    const bind = rerankerBindingOf(config, fakeGateway(), pricing);

    expect(bind({ name: "r", ...priced }).settings.price).toEqual(PRICE);
    expect(
      bind({ name: "r", model: "b/model", modelProvider: "bare-model-provider", unpriced: true })
        .settings,
    ).toMatchObject({ unpriced: true });
    expect(
      bind({ name: "r", model: "b/model", modelProvider: "bare-model-provider" }).settings,
    ).toMatchObject({ unpriced: true });
  });

  it("a DecisionModel decision its provider reports no cost for: tokens × its table", async () => {
    const stub = providerStub([
      {
        body: {
          answers: { q: { type: "boolean", probability: 0.9 } },
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        },
      },
    ]);
    const gateway = createProviderGateway(directory, {
      env: {},
      environment: {} as never,
      calls: instanceCalls(),
      send: stub.fetch,
    });

    const outcome = await gateway.decide({
      caller: "tool:t",
      model: "d/decide",
      modelProvider: "priced-decisions-provider",
      request: { state: "x", questions: { q: { type: "boolean", instructions: "Is it?" } } },
    });

    expect(outcome.usage).toMatchObject({
      provider: "priced-decisions-provider",
      costUsd: usd(30),
      costSource: CostSource.PriceTable,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
  });

  it("a DecisionModel answer that does not fit keeps its priced spend on the failure", async () => {
    const stub = providerStub([
      {
        body: {
          answers: { q: { type: "choice", choice: "z", probabilities: {}, confidence: 1 } },
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        },
      },
    ]);
    const gateway = createProviderGateway(directory, {
      env: {},
      environment: {} as never,
      calls: instanceCalls(),
      send: stub.fetch,
    });
    const { decisionSpendOf } = await import("../../src/finops/failed-decision.js");

    const failure: unknown = await gateway
      .decide({
        caller: "tool:t",
        model: "d/decide",
        modelProvider: "priced-decisions-provider",
        request: { state: "x", questions: { q: { type: "boolean", instructions: "Is it?" } } },
      })
      .catch((error: unknown) => error);

    expect(decisionSpendOf(failure)).toMatchObject({
      costUsd: usd(30),
      costSource: CostSource.PriceTable,
    });
  });
});
