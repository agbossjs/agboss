/**
 * Bughunt 2026-11-25 #6 (regression): a model reranker's model goes through the workflow's cascade
 * resolver like every other model use — a profile's `modelProviders` overlay of its provider's model
 * names, a profile's `ragRerankers` override and the levels' `defaults.models.model` reach it at
 * assembly and at the call. It read the declared provider options alone, so under a prod profile it
 * still called the declared model while every other component switched.
 */
import { describe, expect, it, vi } from "vitest";
import { boundRerankerOf, rerankerModelsOf } from "../../src/components/rag-reranker.js";
import { ragMeta } from "../../src/components/rag.js";
import type { ModelCascade } from "../../src/models/model-cascade.js";
import { ModelCost, ModelProvider, OpenAiCompatibleDriver } from "../../src/models/index.js";
import { Rag, RagReranker, RagScope, RagSource, type RagRetrieval } from "../../src/rag/index.js";
import { seconds, usd } from "../../src/units/index.js";

@ModelProvider({
  name: "local-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://local.test/v1" }),
  model: "local/small",
  models: { fast: "local/fast" },
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "local/big": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  }),
})
class LocalProvider {}

@RagReranker({ name: "default-reranker", candidates: 2, modelProvider: LocalProvider })
class DefaultReranker {}

@RagReranker({ name: "fast-reranker", candidates: 2, model: "fast", modelProvider: LocalProvider })
class FastReranker {}

class NoDocs extends RagSource {
  protected override retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

@Rag({
  name: "default-rag",
  description: "Docs",
  scope: RagScope.Shared,
  topK: 1,
  reranker: DefaultReranker,
})
class DefaultRag extends NoDocs {}

@Rag({
  name: "fast-rag",
  description: "Docs",
  scope: RagScope.Shared,
  topK: 1,
  reranker: FastReranker,
})
class FastRag extends NoDocs {}

/** What `prod.config.ts` says of the provider: another default model, another `fast`. */
const PROD: ModelCascade = {
  providerOverlays: {
    "local-model-provider": { model: "local/big", models: { fast: "local/fast-v2" } },
  },
};

describe("bughunt #6: a model reranker under a profile's modelProviders overlay", () => {
  it("at assembly: a reranker naming no model takes the overlay's model, one naming a role its mapping", () => {
    expect(rerankerModelsOf([DefaultRag, FastRag], PROD)).toEqual([
      // the overlay's model is priced by the provider's table: no unpriced mark
      { name: "default-reranker", model: "local/big", modelProvider: "local-model-provider" },
      { name: "fast-reranker", model: "local/fast-v2", modelProvider: "local-model-provider" },
    ]);
  });

  it("at the call: the binding the gateway gets is the overlay's model", () => {
    const rerankModel = vi.fn((use: object) => use);
    const bound = boundRerankerOf(
      ragMeta(FastRag),
      () => undefined,
      { rerankModel } as never,
      PROD,
    );
    const source = bound?.source as { readonly binding: () => unknown };

    expect(source.binding()).toEqual({
      name: "fast-reranker",
      model: "local/fast-v2",
      modelProvider: "local-model-provider",
    });
  });

  it("a level's defaults.models.model reaches a reranker naming none, on its level's provider", () => {
    const cascade: ModelCascade = { workflow: LocalProvider, models: { workflow: "fast" } };

    expect(rerankerModelsOf([DefaultRag], cascade)).toEqual([
      { name: "default-reranker", model: "local/fast", modelProvider: "local-model-provider" },
    ]);
  });

  it("a profile's ragRerankers override of the model goes through the same resolver", () => {
    const cascade: ModelCascade = {
      ...PROD,
      componentModels: {
        providers: [LocalProvider],
        byKey: new Map([["ragRerankers.fast-reranker", { model: "default" }]]),
        reached: new Set(),
      },
    };

    expect(rerankerModelsOf([FastRag], cascade)).toEqual([
      { name: "fast-reranker", model: "local/big", modelProvider: "local-model-provider" },
    ]);
    expect(cascade.componentModels?.reached.has("ragRerankers.fast-reranker")).toBe(true);
  });
});
