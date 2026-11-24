/**
 * #1313 (was #521 AC1): a breaker a JS project leaves out in other spellings — `null`, `undefined`
 * written out — is no breaker: the application assembles, never a crash.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
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

describe("#1313: the breaker left out in other spellings", () => {
  it.each([
    ["undefined written out", undefined],
    ["null", null],
  ])("circuitBreakerPolicy %s → no breaker, the application assembles", async (label, breaker) => {
    const name = `cast-${label.replace(/\W+/g, "-")}-model-provider`;

    await expect(
      assembled(providerWith(name, breaker), `${name}-application`),
    ).resolves.toBeDefined();
  });
});
