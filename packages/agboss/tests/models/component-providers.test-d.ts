import { describe, expectTypeOf, it } from "vitest";
import type { ModelChannelInterpreterOptions } from "../../src/channels/channel-interpreter.js";
import type { Class } from "../../src/components/injection.js";
import type {
  GuardrailComputedOptions,
  GuardrailTextOptions,
} from "../../src/components/policy-decorators.js";
import type { ModelArbiterOptions } from "../../src/flow/decorators/arbiter.js";
import type { ModelRouterOptions } from "../../src/flow/decorators/router.js";
import type { ModelDefaults } from "../../src/flow/decorators/workflow.js";
import type { DeclarativePiiPolicyOptions } from "../../src/pii/pii-policy.decorator.js";
import type { ModelUseLike } from "../../src/models/model-resolver.js";

/** #1313b: every model-backed component names its provider; a plain `model` is optional. */
describe("#1313b: modelProvider on the components", () => {
  it("a router, an arbiter, a guardrail, a reply interpreter and a PII policy take a provider class", () => {
    expectTypeOf<ModelRouterOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();
    expectTypeOf<ModelArbiterOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();
    expectTypeOf<GuardrailTextOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();
    expectTypeOf<GuardrailComputedOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();
    expectTypeOf<ModelChannelInterpreterOptions["modelProvider"]>().toEqualTypeOf<
      Class | undefined
    >();
    expectTypeOf<DeclarativePiiPolicyOptions["modelProvider"]>().toEqualTypeOf<Class | undefined>();
  });

  it("an arbiter's and an interpreter's model is optional, resolved through the cascade", () => {
    expectTypeOf<ModelArbiterOptions["model"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ModelChannelInterpreterOptions["model"]>().toEqualTypeOf<string | undefined>();
  });

  it("every level's defaults.models takes a default model", () => {
    expectTypeOf<ModelDefaults["model"]>().toEqualTypeOf<string | undefined>();
  });

  it("a resolved model use names the provider and its price mark", () => {
    expectTypeOf<ModelUseLike["modelProvider"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ModelUseLike["unpriced"]>().toEqualTypeOf<true | undefined>();
  });
});
