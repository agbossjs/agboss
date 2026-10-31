/**
 * #521 AC1, acceptance corner cases: a breaker that a JS project leaves out in other spellings —
 * `null`, `undefined` written out — fails assembly by name, never a crash (before the fix, `null`
 * assembled and createApp threw a TypeError destructuring it).
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import {
  ModelCost,
  ModelProvider,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderResponse,
} from "../../src/models/index.js";
import type { TransportModelProviderOptions } from "../../src/models/model-provider.decorator.js";
import { seconds } from "../../src/units/index.js";
import { bedrockApplicationOn } from "./transport/bedrock-apps.fixture.js";
import { answer } from "./transport/bedrock-provider.fixture.js";

const base: Omit<TransportModelProviderOptions, "name" | "circuitBreakerPolicy"> = {
  description: "A transport whose options lost their breaker",
  serves: [/^bedrock\//],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
};

function providerWith(name: string, breaker: null | undefined): new () => ModelProviderHandler {
  // what a JS project hands the decorator: the policy spelled out as nothing
  const options = Object.assign({ ...base, name }, { circuitBreakerPolicy: breaker });
  @ModelProvider(
    options as Omit<typeof options, "circuitBreakerPolicy"> as TransportModelProviderOptions,
  )
  class CastModelProvider implements ModelProviderHandler {
    complete(): Promise<ModelProviderResponse> {
      return Promise.resolve(answer("never"));
    }
  }
  return CastModelProvider;
}

const assembled = (provider: new () => ModelProviderHandler, name: string) =>
  applicationOf(bedrockApplicationOn({ name, providers: [provider] }), {});

describe("#521 AC1 acceptance: the breaker left out in other spellings", () => {
  it.each([
    ["undefined written out", undefined],
    ["null", null],
  ])("AC1: circuitBreakerPolicy %s → the named rule, never a TypeError", async (label, breaker) => {
    const name = `cast-${label.replace(/\W+/g, "-")}-model-provider`;
    const running = assembled(providerWith(name, breaker), `${name}-application`);

    await expect(running).rejects.toBeInstanceOf(GraphRuleError);
    await expect(running).rejects.toThrow(
      `[model-provider.circuit-breaker-required] ${name} (CastModelProvider) has no circuitBreakerPolicy`,
    );
  });
});
