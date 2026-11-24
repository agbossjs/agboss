import { describe, expectTypeOf, it } from "vitest";
import type { AgentExecutionLimits, AgentOptions } from "../../src/public/flow.js";
import {
  PromptCaching,
  type ModelPrice,
  type ModelProviderDecisionRequest,
  type ModelProviderHandler,
} from "../../src/models/index.js";
import { usd } from "../../src/units/index.js";

describe("#1313e: PromptCaching.on, executionLimits, cache prices, decide", () => {
  it("PromptCaching.on takes no option, and no field is required", () => {
    expectTypeOf(PromptCaching.on()).toEqualTypeOf<PromptCaching>();
    expectTypeOf(PromptCaching.on({ key: "k" })).toEqualTypeOf<PromptCaching>();
    // @ts-expect-error whereSupported is gone: `on` is the explicit, fail-fast form
    PromptCaching.whereSupported({});
  });

  it("an agent's caps are grouped in executionLimits; the flat ones are gone", () => {
    expectTypeOf<AgentOptions["executionLimits"]>().toEqualTypeOf<
      AgentExecutionLimits | undefined
    >();
    expectTypeOf<keyof AgentExecutionLimits>().toEqualTypeOf<
      "maxVisits" | "maxModelCalls" | "maxToolCalls" | "maxRetries"
    >();
    expectTypeOf<AgentOptions>().not.toHaveProperty("maxToolCalls");
    expectTypeOf<AgentOptions>().not.toHaveProperty("maxRetries");
    expectTypeOf<AgentOptions>().not.toHaveProperty("maxVisits");
  });

  it("a model price has cacheReadPerMillion and cacheWritePerMillion, not cachedInputPerMillion", () => {
    const price: ModelPrice = {
      inputPerMillion: usd(1),
      outputPerMillion: usd(2),
      cacheReadPerMillion: usd(0.1),
      cacheWritePerMillion: usd(1.25),
    };
    expectTypeOf(price.cacheWritePerMillion).toEqualTypeOf<ReturnType<typeof usd> | undefined>();
    const old = {
      inputPerMillion: usd(1),
      outputPerMillion: usd(2),
      // @ts-expect-error renamed to cacheReadPerMillion
      cachedInputPerMillion: usd(1),
    } satisfies ModelPrice;
    expectTypeOf(old.inputPerMillion).toEqualTypeOf<ReturnType<typeof usd>>();
  });

  it("a provider decides with a ModelProviderDecisionRequest", () => {
    expectTypeOf<NonNullable<ModelProviderHandler["decide"]>>().parameters.toEqualTypeOf<
      [ModelProviderDecisionRequest]
    >();
    expectTypeOf<ModelProviderDecisionRequest>().toHaveProperty("model");
    expectTypeOf<ModelProviderDecisionRequest>().toHaveProperty("connection");
  });
});
