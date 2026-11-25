import { describe, expectTypeOf, it } from "vitest";
import {
  CircuitBreakerPolicy,
  ModelProvider,
  type ModelFallback,
  type ModelProviderOptions,
} from "../../src/models/index.js";
import { minutes, seconds } from "../../src/units/index.js";

describe("#1313c: the breaker policy and the fallback, as types", () => {
  it("fixed and exponential make a CircuitBreakerPolicy", () => {
    expectTypeOf(
      CircuitBreakerPolicy.fixed({
        failureThreshold: 1,
        failureWindow: minutes(1),
        openDuration: seconds(1),
      }),
    ).toEqualTypeOf<CircuitBreakerPolicy>();
  });

  it("the old literal, the window and openFor fields, and a fallback in the policy are gone", () => {
    const accepts = (_policy: CircuitBreakerPolicy): undefined => undefined;
    const fixed = { failureThreshold: 1, failureWindow: minutes(1), openDuration: seconds(1) };
    // @ts-expect-error the policy is made by `fixed` or `exponential`
    accepts({ failureThreshold: 1, window: minutes(1), openFor: seconds(1) });
    // @ts-expect-error `window` is `failureWindow`, `openFor` is `openDuration`
    CircuitBreakerPolicy.fixed({ failureThreshold: 1, window: minutes(1), openFor: seconds(1) });
    // @ts-expect-error `fallback` is an option of the provider
    CircuitBreakerPolicy.fixed({ ...fixed, fallback: Date });
  });

  it("a provider's fallback is a class or a class with its models", () => {
    expectTypeOf<ModelProviderOptions["fallback"]>().toEqualTypeOf<ModelFallback | undefined>();
    expectTypeOf<{
      provider: abstract new () => object;
      models: { a: "b" };
    }>().toExtend<ModelFallback>();
    expectTypeOf(ModelProvider).toBeFunction();
  });
});
