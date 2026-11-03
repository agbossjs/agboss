/**
 * #644 (5): an OpenAI-compatible `@ModelProvider` whose class sets no `requestFields` (the type
 * requires it; a JS project or a run before `tsc` reaches this) fails the application's assembly —
 * and so `agboss check` — with `[model-provider.request-fields-missing]`, naming the provider, never
 * a `TypeError` at its first model call. An HTTP provider without `promptCaching` stays as it is:
 * the decorator keeps it as off (`PromptCaching.off()`), so nothing crashes.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import {
  ModelCost,
  ModelProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
} from "../../src/models/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { OpenRouterProvider, type OpenRouterFields } from "../../src/models/openrouter.provider.js";
import { minutes, seconds } from "../../src/units/index.js";
import { bedrockApplicationOn } from "./transport/bedrock-apps.fixture.js";

const options = {
  description: "An OpenRouter subclass",
  serves: [/^bedrock\//],
  baseUrl: "https://openrouter.example/api/v1",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 1, window: minutes(1), openFor: minutes(1) },
  reasoning: Reasoning.off(),
} as const;

@ModelProvider({ ...options, name: "bare-model-provider", promptCaching: PromptCaching.off() })
// @ts-expect-error — what a JS project writes: the abstract requestFields left out
class BareModelProvider extends OpenRouterProvider {}

// @ts-expect-error — what a JS project writes: promptCaching left out
@ModelProvider({ ...options, name: "fielded-model-provider" })
class FieldedModelProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {};
}

describe("#644 (5): a provider subclass without requestFields", () => {
  it("assembly fails with [model-provider.request-fields-missing], naming the provider", async () => {
    const application = bedrockApplicationOn({
      name: "bare-application",
      providers: [BareModelProvider],
    });

    const assembled = applicationOf(application, {});

    await expect(assembled).rejects.toBeInstanceOf(GraphRuleError);
    await expect(assembled).rejects.toThrow(
      /\[model-provider\.request-fields-missing\] bare-model-provider \(BareModelProvider\) sets no requestFields/,
    );
  });

  it("with requestFields it assembles; an unset promptCaching is kept as off", async () => {
    const application = bedrockApplicationOn({
      name: "fielded-application",
      providers: [FieldedModelProvider],
    });

    await expect(applicationOf(application, {})).resolves.toBeDefined();
    expect(modelProviderOf(FieldedModelProvider).promptCaching).toEqual({ kind: "off" });
  });
});
