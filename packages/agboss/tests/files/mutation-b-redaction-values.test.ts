/**
 * #1269 (files-pii mutation shard): who the redaction model's provider is, as `withRedactionValues` and
 * `isSameProvider` decide it — fail-closed on every doubt: a setting that does not say so, a use that is
 * missing, a provider that is unknown, two servers that differ in any part of their identity.
 */
import { describe, expect, it } from "vitest";
import { FileView, RedactionValues } from "../../src/files/model-files.js";
import {
  isSameProvider,
  valuesForRedactor,
  withRedactionValues,
} from "../../src/files/redaction-values.js";
import type { AgentsConfigOf } from "../../src/config/types.js";
import {
  ModelProvider,
  OpenAiCompatibleProvider,
  type NoRequestFields,
} from "../../src/models/index.js";
import {
  modelProviderOf,
  type ModelProviderType,
} from "../../src/models/model-provider.decorator.js";
import { directoryOf } from "../../src/models/workflow-models.js";
import { ModelKind } from "../../src/models/model-kind.js";
import { registeredOf, type RegisteredModelProvider } from "../../src/models/resolve.js";
import type { ModelUse, ModelUseKey } from "../../src/models/uses.js";
import { seconds } from "../../src/units/index.js";
import { httpOptionsOf, LocalModelProvider } from "../models/providers.fixture.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";

const BASE = httpOptionsOf(LocalModelProvider);

const optionsOf = (over: {
  readonly name: string;
  readonly serves: RegExp;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly baseUrlField?: string;
}) => ({
  ...BASE,
  name: over.name,
  serves: [over.serves],
  baseUrl: over.baseUrl,
  apiKey: over.apiKey,
  baseUrlField: over.baseUrlField,
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 5,
    failureWindow: seconds(60),
    openDuration: seconds(30),
  }),
});

@ModelProvider(
  optionsOf({
    name: "p1-model-provider",
    serves: /^p1\//u,
    baseUrl: "https://s.example/v1",
    apiKey: "keyP",
  }),
)
class P1 extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}
// the same server and key field as P1: another class
@ModelProvider(
  optionsOf({
    name: "p2-model-provider",
    serves: /^p2\//u,
    baseUrl: "https://s.example/v1",
    apiKey: "keyP",
  }),
)
class P2 extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}
// the same server, another key field
@ModelProvider(
  optionsOf({
    name: "p3-model-provider",
    serves: /^p3\//u,
    baseUrl: "https://s.example/v1",
    apiKey: "keyQ",
  }),
)
class P3 extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}
// another server, the same key field
@ModelProvider(
  optionsOf({
    name: "p4-model-provider",
    serves: /^p4\//u,
    baseUrl: "https://t.example/v1",
    apiKey: "keyP",
  }),
)
class P4 extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}
// the same server and key field, another environment field for the base URL
@ModelProvider(
  optionsOf({
    name: "p5-model-provider",
    serves: /^p5\//u,
    baseUrl: "https://s.example/v1",
    apiKey: "keyP",
    baseUrlField: "proxyUrl",
  }),
)
class P5 extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}
// no key field: nothing says whose credentials these are
@ModelProvider(
  optionsOf({
    name: "k-model-provider",
    serves: /^(?:k|\/k)\/|^(?:m|\/m)$/u,
    baseUrl: "https://k.example/v1",
  }),
)
class Keyless extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

// serves the one model of the vendor "q" that is served at all
@ModelProvider(
  optionsOf({
    name: "q-model-provider",
    serves: /^q\/2$/u,
    baseUrl: "https://q.example/v1",
    apiKey: "keyQ2",
  }),
)
class Q extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

const PROVIDERS: readonly ModelProviderType[] = [P1, P2, P3, P4, P5, Keyless, Q];
const directory = directoryOf(PROVIDERS);

const use = (key: ModelUseKey, model: string): ModelUse => ({
  key,
  model,
  purpose: ModelKind.Chat,
});
const providerOf = (found: ModelUse): RegisteredModelProvider | undefined => {
  const resolution = directory.resolve(found);
  return resolution.kind === "resolved" ? resolution.provider : undefined;
};

const configWith = (redactionValues: RedactionValues | undefined): AgentsConfigOf<string> =>
  ({
    defaults: { models: {} },
    agents: {
      "x-agent": {
        model: "m",
        files: {
          views: [FileView.Redacted],
          ...(redactionValues === undefined ? {} : { redactionValues }),
        },
      },
    },
  }) as never;

/** What `withRedactionValues` decides for an agent on `agentModel` and a redaction model, from the uses given. */
function sends(
  redactionValues: RedactionValues | undefined,
  uses: readonly ModelUse[],
): boolean | undefined {
  const resolved = withRedactionValues(configWith(redactionValues), uses, providerOf);
  const files = resolved.agents["x-agent"]?.files as { redactionSendsValues?: boolean } | undefined;
  return files?.redactionSendsValues;
}

const pair = (agentModel: string, redactorModel: string): ModelUse[] => [
  use("agents.x-agent", agentModel),
  use("fileMaskers.x-agent", redactorModel),
];

describe("the setting decides first, the providers second", () => {
  it("Always sends, whatever the providers; Never and no setting do not, even for one provider", () => {
    expect(sends(RedactionValues.Always, pair("p1/a", "p3/b"))).toBe(true);
    expect(sends(RedactionValues.Always, [])).toBe(true);
    expect(sends(RedactionValues.Never, pair("p1/a", "p1/b"))).toBe(false);
    expect(sends(undefined, pair("p1/a", "p1/b"))).toBe(false);
    expect(sends(RedactionValues.SameProvider, pair("p1/a", "p1/b"))).toBe(true);
  });

  it("a missing use of the agent or of the redactor is never the same provider", () => {
    expect(sends(RedactionValues.SameProvider, [use("fileMaskers.x-agent", "p1/b")])).toBe(
      false,
    );
    expect(sends(RedactionValues.SameProvider, [use("agents.x-agent", "p1/a")])).toBe(false);
  });

  it("a use no provider serves, on either side, is never the same provider", () => {
    expect(sends(RedactionValues.SameProvider, pair("zzz/a", "p1/b"))).toBe(false);
    expect(sends(RedactionValues.SameProvider, pair("p1/a", "zzz/b"))).toBe(false);
    // the same vendor, but only the redactor's model is served
    expect(sends(RedactionValues.SameProvider, pair("q/1", "q/2"))).toBe(false);
  });

  it("each use is found by its own key, among the uses of other agents", () => {
    const others = [use("agents.other", "zzz/a"), use("fileMaskers.other", "p3/b")];

    expect(sends(RedactionValues.SameProvider, [...others, ...pair("p1/a", "p1/b")])).toBe(true);
  });
});

describe("two providers are one only by the same server under the same key", () => {
  it("one server and one key field are the same, whatever the class", () => {
    expect(sends(RedactionValues.SameProvider, pair("p1/a", "p2/a"))).toBe(false); // other vendor
    expect(isSameProvider(used("p1/a", P1), used("p1/b", P2))).toBe(true);
  });

  it("a key field, a base URL or the base URL's own field that differs is another provider", () => {
    expect(isSameProvider(used("p1/a", P1), used("p1/b", P3))).toBe(false);
    expect(isSameProvider(used("p1/a", P1), used("p1/b", P4))).toBe(false);
    expect(isSameProvider(used("p1/a", P1), used("p1/b", P5))).toBe(false);
  });

  it("the same class is the same provider, even with no key field; two classes with none are not", () => {
    expect(isSameProvider(used("k/a", Keyless), used("k/b", Keyless))).toBe(true);
    expect(isSameProvider(used("k/a", Keyless), used("k/b", P2))).toBe(false);
  });

  it("a model with a vendor is not a model without one, even a bare '/' away", () => {
    expect(isSameProvider(used("m", Keyless), used("m", Keyless))).toBe(true);
    expect(isSameProvider(used("m", Keyless), used("/m", Keyless))).toBe(false);
    expect(isSameProvider(used("/m", Keyless), used("m", Keyless))).toBe(false);
    expect(isSameProvider(used("/m", Keyless), used("/m", Keyless))).toBe(true);
  });

  it("providers that are no HTTP server are never the same server, whatever fields they carry alike", () => {
    const transport = (type: ModelProviderType): RegisteredModelProvider => ({
      ...registeredOf(type),
      options: { ...modelProviderOf(P1), baseUrl: undefined, baseUrlField: undefined } as never,
    });

    expect(
      isSameProvider(
        { provider: transport(P1), model: "p1/a" },
        { provider: transport(P2), model: "p1/b" },
      ),
    ).toBe(false);
  });

  it("a redaction provider with no breaker policy at all is judged on its identity, not crashed on", () => {
    const { circuitBreakerPolicy: _breaker, ...bare } = modelProviderOf(P1);
    const noBreaker: RegisteredModelProvider = { ...registeredOf(P1), options: bare };

    expect(
      isSameProvider(
        { provider: registeredOf(P1), model: "p1/a" },
        { provider: noBreaker, model: "p1/b" },
      ),
    ).toBe(true);
  });
});

function used(
  model: string,
  type: ModelProviderType,
): { provider: RegisteredModelProvider; model: string } {
  return { provider: registeredOf(type), model };
}

describe("the values a redactor is handed", () => {
  it("are the execution's only where the settings let them go", () => {
    expect(valuesForRedactor({ redactionSendsValues: true }, ["a", "b"])).toEqual(["a", "b"]);
    expect(valuesForRedactor({ redactionSendsValues: false }, ["a"])).toEqual([]);
    expect(valuesForRedactor({}, ["a"])).toEqual([]);
  });
});
