import { describe, expectTypeOf, it } from "vitest";
import type { RuleCode } from "../../src/graph/rule-codes.js";
import * as models from "../../src/models/index.js";
import type {
  ModelProblemCode,
  ModelProviderHandler,
  ModelProviderOptions,
} from "../../src/models/index.js";

/** F2 (#1313): the 0.1.0 provider forms are gone — a provider is a driver or a transport, reached through `modelProvider`. */
describe("F2: the old provider forms are removed", () => {
  it("a provider handler has complete, stream, decide and capabilities — no chat, no routeTo", () => {
    const handler = {} as ModelProviderHandler;

    // `chat` is the driver's own, not part of a provider class's contract
    expectTypeOf(handler).not.toHaveProperty("chat");
    // `routeTo` is `decide`
    expectTypeOf(handler).not.toHaveProperty("routeTo");
    expectTypeOf(handler.decide).not.toBeAny();
  });

  it("the provider classes of 0.1.0 and their defaults are not exported", () => {
    // OpenAiCompatibleDriver
    expectTypeOf(models).not.toHaveProperty("OpenAiCompatibleProvider");
    // OpenRouterDriver
    expectTypeOf(models).not.toHaveProperty("OpenRouterProvider");
    // a provider is named by `modelProvider`; there is no built-in one
    expectTypeOf(models).not.toHaveProperty("OpenRouterModelProvider");
    // DecisionsDriver
    expectTypeOf(models).not.toHaveProperty("DecisionsModelProvider");
    // the deprecated alias
    expectTypeOf(models).not.toHaveProperty("JevModelProvider");
    // no defaults: every component reaches a provider through `modelProvider`
    expectTypeOf(models).not.toHaveProperty("DEFAULT_MODEL_PROVIDERS");
    // a model's name tells no kind: its provider's driver does
    expectTypeOf(models).not.toHaveProperty("isDecisionModel");
    // a driver's `baseUrl`
    expectTypeOf(models).not.toHaveProperty("OPENROUTER_BASE_URL");
  });

  it("the provider options have no serves, baseUrl, baseUrlField or apiKey", () => {
    expectTypeOf<ModelProviderOptions>().not.toHaveProperty("serves");
    expectTypeOf<ModelProviderOptions>().not.toHaveProperty("baseUrl");
    expectTypeOf<ModelProviderOptions>().not.toHaveProperty("baseUrlField");
    expectTypeOf<ModelProviderOptions>().not.toHaveProperty("apiKey");
  });

  it("model.unserved and model.ambiguous-provider are no codes any more", () => {
    expectTypeOf<ModelProblemCode>().not.toEqualTypeOf<"model.unserved">();
    expectTypeOf<"model.unserved">().not.toExtend<ModelProblemCode>();
    expectTypeOf<"model.ambiguous-provider">().not.toExtend<ModelProblemCode>();
    expectTypeOf<"model.unserved">().not.toExtend<RuleCode>();
    expectTypeOf<"model.ambiguous-provider">().not.toExtend<RuleCode>();
    expectTypeOf<"model.missing-provider">().toExtend<ModelProblemCode>();
  });
});
