/**
 * #899 §6 (post-merge review): whether the redaction model is "the same provider" as the agent's own is
 * decided by a fail-closed identity — the same provider, or the same base URL and key field — never by a
 * name two providers could share, and never across an aggregator's vendors or a breaker's fallback. In
 * doubt it is not the same, and the exact values stay home.
 */
import { describe, expect, it } from "vitest";
import { FileView, RedactionValues } from "../../src/files/model-files.js";
import { withRedactionValues } from "../../src/files/redaction-values.js";
import { DEFAULT_MODEL_PROVIDERS, directoryOf } from "../../src/models/workflow-models.js";
import {
  ModelProvider,
  OpenAiCompatibleProvider,
  type NoRequestFields,
} from "../../src/models/index.js";
import type { ModelProviderType } from "../../src/models/model-provider.decorator.js";
import { ModelPurpose } from "../../src/models/resolve.js";
import { seconds } from "../../src/units/index.js";
import { httpOptionsOf, LocalModelProvider } from "../models/providers.fixture.js";

const BASE = httpOptionsOf(LocalModelProvider);

const optionsOf = (over: {
  readonly name: string;
  readonly serves: RegExp;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fallback?: ModelProviderType;
}) => ({
  ...BASE,
  name: over.name,
  serves: [over.serves],
  baseUrl: over.baseUrl,
  ...(over.apiKey === undefined ? { apiKey: undefined } : { apiKey: over.apiKey }),
  circuitBreakerPolicy: {
    failureThreshold: 5,
    window: seconds(60),
    openFor: seconds(30),
    ...(over.fallback === undefined ? {} : { fallback: over.fallback }),
  },
});

@ModelProvider(
  optionsOf({
    name: "a-model-provider",
    serves: /^a\/(?!x-|y-)/u,
    baseUrl: "https://a.example/v1",
    apiKey: "keyA",
  }),
)
class AProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

@ModelProvider(
  optionsOf({
    name: "b-model-provider",
    serves: /^b\//u,
    baseUrl: "https://b.example/v1",
    apiKey: "keyB",
  }),
)
class BProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

// the same display name as AProvider, another server
@ModelProvider(
  optionsOf({
    name: "a-model-provider",
    serves: /^a\/y-/u,
    baseUrl: "https://c.example/v1",
    apiKey: "keyC",
  }),
)
class NamesakeProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

// another class for the same server and the same key field as AProvider
@ModelProvider(
  optionsOf({
    name: "a2-model-provider",
    serves: /^(?:a\/x-|z\/)/u,
    baseUrl: "https://a.example/v1",
    apiKey: "keyA",
  }),
)
class SameServerProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

// the same server, no key field: nothing says whose credentials these are
@ModelProvider(
  optionsOf({ name: "k1-model-provider", serves: /^k\/1-/u, baseUrl: "https://k.example/v1" }),
)
class KeylessOne extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}
@ModelProvider(
  optionsOf({ name: "k2-model-provider", serves: /^k\/2-/u, baseUrl: "https://k.example/v1" }),
)
class KeylessTwo extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

// serves what AProvider's breaker fails over to
@ModelProvider(
  optionsOf({
    name: "f-model-provider",
    serves: /^f\//u,
    baseUrl: "https://f.example/v1",
    apiKey: "keyF",
    fallback: BProvider,
  }),
)
class FailingOver extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

/** Whether the agent's redaction model is the same provider, as `withRedactionValues` decides it. */
function sendsValues(
  providers: readonly ModelProviderType[],
  agentModel: string,
  redactorModel: string,
): boolean | undefined {
  const directory = directoryOf(providers);
  const config = {
    defaults: { models: {} },
    agents: {
      "x-agent": {
        model: agentModel,
        files: { views: [FileView.Redacted], redactionValues: RedactionValues.SameProvider },
      },
    },
  } as never;
  const uses = [
    { key: "agents.x-agent", model: agentModel, purpose: ModelPurpose.Chat },
    { key: "files.redactor.x-agent", model: redactorModel, purpose: ModelPurpose.Chat },
  ] as never;
  const resolved = withRedactionValues(config, uses, (use) => {
    const resolution = directory.resolve(use);
    // a fixture that two providers claim would pass for the wrong reason
    if (resolution.kind === "problem" && resolution.problem.code === "model.ambiguous-provider")
      throw new Error(`${use.key} is claimed by several providers`);
    return resolution.kind === "resolved" ? resolution.provider : undefined;
  });
  return (resolved.agents["x-agent"]?.files as { redactionSendsValues?: boolean } | undefined)
    ?.redactionSendsValues;
}

describe("the redaction model is the same provider only by a fail-closed identity", () => {
  it("the default aggregator serves every vendor: another vendor's model is another provider", () => {
    expect(
      sendsValues(
        DEFAULT_MODEL_PROVIDERS,
        "anthropic/claude-sonnet-4",
        "google/gemini-2.5-flash-lite",
      ),
    ).toBe(false);
    expect(
      sendsValues(DEFAULT_MODEL_PROVIDERS, "anthropic/claude-sonnet-4", "anthropic/claude-haiku-4"),
    ).toBe(true);
  });

  it("two providers that share a display name are not the same", () => {
    expect(sendsValues([AProvider, NamesakeProvider], "a/m", "a/y-m")).toBe(false);
  });

  it("the same provider is the same; two providers on one base URL and one key field are the same", () => {
    expect(sendsValues([AProvider, BProvider], "a/m", "a/other")).toBe(true);
    expect(sendsValues([AProvider, SameServerProvider], "a/m", "a/x-m")).toBe(true);
    // one server behind both, but the model is another vendor's
    expect(sendsValues([AProvider, SameServerProvider], "a/m", "z/m")).toBe(false);
    expect(sendsValues([AProvider, BProvider], "a/m", "b/m")).toBe(false);
  });

  it("one base URL without a key field proves no common credentials: not the same", () => {
    expect(sendsValues([KeylessOne, KeylessTwo], "k/1-m", "k/2-m")).toBe(false);
  });

  it("a redaction provider whose breaker fails over to another provider is not the same, even as the agent's own", () => {
    expect(sendsValues([FailingOver, BProvider], "f/m", "f/other")).toBe(false);
  });

  it("a model no provider serves is never the same", () => {
    expect(sendsValues([AProvider], "a/m", "zzz/m")).toBe(false);
  });
});
