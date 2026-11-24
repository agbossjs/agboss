/**
 * #899 §6 (post-merge review): whether the redaction model is "the same provider" as the agent's own is
 * decided by a fail-closed identity — the same provider, or the same base URL and key field — never by a
 * name two providers could share, and never across an aggregator's vendors or a breaker's fallback. In
 * doubt it is not the same, and the exact values stay home.
 */
import { describe, expect, it } from "vitest";
import { FileView, RedactionValues } from "../../src/files/model-files.js";
import { withRedactionValues } from "../../src/files/redaction-values.js";
import { directoryOf } from "../../src/models/workflow-models.js";
import { secret } from "../../src/environments/secret.js";
import { ModelProvider, OpenAiCompatibleDriver } from "../../src/models/index.js";
import type { ModelProviderType } from "../../src/models/model-provider.decorator.js";
import { ModelKind } from "../../src/models/model-kind.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";
import { seconds } from "../../src/units/index.js";
import { TestOpenRouterProvider } from "../models/providers.fixture.js";

const common = {
  timeout: seconds(5),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 5,
    failureWindow: seconds(60),
    openDuration: seconds(30),
  }),
};

@ModelProvider({
  ...common,
  name: "a-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://a.example/v1", apiKey: secret("KEY_A") }),
})
class AProvider {}

@ModelProvider({
  ...common,
  name: "b-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://b.example/v1", apiKey: secret("KEY_B") }),
})
class BProvider {}

// the same display name as AProvider, another server
@ModelProvider({
  ...common,
  name: "a-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://c.example/v1", apiKey: secret("KEY_C") }),
})
class NamesakeProvider {}

// another class for the same server and the same key as AProvider
@ModelProvider({
  ...common,
  name: "a2-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://a.example/v1", apiKey: secret("KEY_A") }),
})
class SameServerProvider {}

// the same server, no key: nothing says whose credentials these are
@ModelProvider({
  ...common,
  name: "k1-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://k.example/v1" }),
})
class KeylessOne {}
@ModelProvider({
  ...common,
  name: "k2-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://k.example/v1" }),
})
class KeylessTwo {}

// the provider whose breaker fails over to BProvider
@ModelProvider({
  ...common,
  name: "f-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://f.example/v1", apiKey: secret("KEY_F") }),
  fallback: BProvider,
})
class FailingOver {}

/** Whether the agent's redaction model is the same provider, as `withRedactionValues` decides it. */
function sendsValues(
  providers: readonly ModelProviderType[],
  agentModel: string,
  redactorModel: string,
  names: { readonly agent?: string; readonly redactor?: string } = {},
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
    {
      key: "agents.x-agent",
      model: agentModel,
      purpose: ModelKind.Chat,
      modelProvider: names.agent,
    },
    {
      key: "fileMaskers.x-agent",
      model: redactorModel,
      purpose: ModelKind.Chat,
      modelProvider: names.redactor,
    },
  ] as never;
  const resolved = withRedactionValues(config, uses, (use) => {
    const resolution = directory.resolve(use);
    return resolution.kind === "resolved" ? resolution.provider : undefined;
  });
  return (resolved.agents["x-agent"]?.files as { redactionSendsValues?: boolean } | undefined)
    ?.redactionSendsValues;
}

const [A, B, A2, F] = [
  "a-model-provider",
  "b-model-provider",
  "a2-model-provider",
  "f-model-provider",
];
const OPENROUTER = "openrouter-model-provider";

describe("the redaction model is the same provider only by a fail-closed identity", () => {
  it("an aggregator serves every vendor: another vendor's model is another provider", () => {
    const names = { agent: OPENROUTER, redactor: OPENROUTER };
    expect(
      sendsValues(
        [TestOpenRouterProvider],
        "anthropic/claude-sonnet-4",
        "google/gemini-2.5-flash-lite",
        names,
      ),
    ).toBe(false);
    expect(
      sendsValues(
        [TestOpenRouterProvider],
        "anthropic/claude-sonnet-4",
        "anthropic/claude-haiku-4",
        names,
      ),
    ).toBe(true);
  });

  it("two providers that share a display name are not the same", () => {
    expect(
      sendsValues([AProvider, NamesakeProvider], "a/m", "a/y-m", { agent: A, redactor: A }),
    ).toBe(false);
  });

  it("the same provider is the same; two providers on one base URL and one key are the same", () => {
    expect(sendsValues([AProvider, BProvider], "a/m", "a/other", { agent: A, redactor: A })).toBe(
      true,
    );
    expect(
      sendsValues([AProvider, SameServerProvider], "a/m", "a/x-m", { agent: A, redactor: A2 }),
    ).toBe(true);
    // one server behind both, but the model is another vendor's
    expect(
      sendsValues([AProvider, SameServerProvider], "a/m", "z/m", { agent: A, redactor: A2 }),
    ).toBe(false);
    expect(sendsValues([AProvider, BProvider], "a/m", "b/m", { agent: A, redactor: B })).toBe(
      false,
    );
  });

  it("one base URL without a key proves no common credentials: not the same", () => {
    expect(
      sendsValues([KeylessOne, KeylessTwo], "k/1-m", "k/2-m", {
        agent: "k1-model-provider",
        redactor: "k2-model-provider",
      }),
    ).toBe(false);
  });

  it("a redaction provider whose breaker fails over to another provider is not the same, even as the agent's own", () => {
    expect(sendsValues([FailingOver, BProvider], "f/m", "f/other", { agent: F, redactor: F })).toBe(
      false,
    );
  });

  it("a model no provider is named for is never the same", () => {
    expect(sendsValues([AProvider], "a/m", "zzz/m", { agent: A })).toBe(false);
  });
});
