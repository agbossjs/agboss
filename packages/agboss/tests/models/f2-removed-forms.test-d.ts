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

    // @ts-expect-error — `chat` is the driver's own, not part of a provider class's contract
    handler.chat;
    // @ts-expect-error — `routeTo` is `decide`
    handler.routeTo;
    expectTypeOf(handler.decide).not.toBeAny();
  });

  it("the provider classes of 0.1.0 and their defaults are not exported", () => {
    // @ts-expect-error — OpenAiCompatibleDriver
    models.OpenAiCompatibleProvider;
    // @ts-expect-error — OpenRouterDriver
    models.OpenRouterProvider;
    // @ts-expect-error — a provider is named by `modelProvider`; there is no built-in one
    models.OpenRouterModelProvider;
    // @ts-expect-error — DecisionsDriver
    models.DecisionsModelProvider;
    // @ts-expect-error — the deprecated alias
    models.JevModelProvider;
    // @ts-expect-error — no defaults: every component reaches a provider through `modelProvider`
    models.DEFAULT_MODEL_PROVIDERS;
    // @ts-expect-error — a model's name tells no kind: its provider's driver does
    models.isDecisionModel;
    // @ts-expect-error — a driver's `baseUrl`
    models.OPENROUTER_BASE_URL;
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
