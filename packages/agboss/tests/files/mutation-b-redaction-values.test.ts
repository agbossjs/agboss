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
import { env } from "../../src/environments/env-readers.js";
import { secret } from "../../src/environments/secret.js";
import { ModelProvider, OpenAiCompatibleDriver } from "../../src/models/index.js";
import {
  modelProviderOf,
  type ModelProviderType,
} from "../../src/models/model-provider.decorator.js";
import { directoryOf } from "../../src/models/workflow-models.js";
import { ModelKind } from "../../src/models/model-kind.js";
import { registeredOf, type RegisteredModelProvider } from "../../src/models/resolve.js";
import type { ModelUse, ModelUseKey } from "../../src/models/uses.js";
import { seconds } from "../../src/units/index.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";

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
  name: "p1-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://s.example/v1", apiKey: secret("KEY_P") }),
})
class P1 {}
// the same server and key as P1: another class
@ModelProvider({
  ...common,
  name: "p2-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://s.example/v1", apiKey: secret("KEY_P") }),
})
class P2 {}
// the same server, another key
@ModelProvider({
  ...common,
  name: "p3-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://s.example/v1", apiKey: secret("KEY_Q") }),
})
class P3 {}
// another server, the same key
@ModelProvider({
  ...common,
  name: "p4-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://t.example/v1", apiKey: secret("KEY_P") }),
})
class P4 {}
// the same key, the base URL read from another variable
@ModelProvider({
  ...common,
  name: "p5-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: env("PROXY_URL"), apiKey: secret("KEY_P") }),
})
class P5 {}
// the same server and key, another header: another account
@ModelProvider({
  ...common,
  name: "p6-model-provider",
  driver: OpenAiCompatibleDriver({
    baseUrl: "https://s.example/v1",
    apiKey: secret("KEY_P"),
    headers: { "x-tenant": "acme" },
  }),
})
class P6 {}
// no key: nothing says whose credentials these are
@ModelProvider({
  ...common,
  name: "k-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "https://k.example/v1" }),
})
class Keyless {}

const PROVIDERS: readonly ModelProviderType[] = [P1, P2, P3, P4, P5, P6, Keyless];
const directory = directoryOf(PROVIDERS);

/** The provider each test vendor's models go to, as a component's `modelProvider` says (`p1/a` → p1). */
const providerNameOf = (model: string): string | undefined => {
  if (model === "m" || model === "/m" || model.startsWith("k/")) return "k-model-provider";
  const vendor = model.split("/")[0] ?? "";
  return /^p[1-6]$/u.test(vendor) ? `${vendor}-model-provider` : undefined;
};

const use = (key: ModelUseKey, model: string): ModelUse => {
  const modelProvider = providerNameOf(model);
  return {
    key,
    model,
    purpose: ModelKind.Chat,
    ...(modelProvider === undefined ? {} : { modelProvider }),
  };
};
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
    expect(sends(RedactionValues.SameProvider, [use("fileMaskers.x-agent", "p1/b")])).toBe(false);
    expect(sends(RedactionValues.SameProvider, [use("agents.x-agent", "p1/a")])).toBe(false);
  });

  it("a use no provider is named for, on either side, is never the same provider", () => {
    expect(sends(RedactionValues.SameProvider, pair("zzz/a", "p1/b"))).toBe(false);
    expect(sends(RedactionValues.SameProvider, pair("p1/a", "zzz/b"))).toBe(false);
  });

  it("each use is found by its own key, among the uses of other agents", () => {
    const others = [use("agents.other", "zzz/a"), use("fileMaskers.other", "p3/b")];

    expect(sends(RedactionValues.SameProvider, [...others, ...pair("p1/a", "p1/b")])).toBe(true);
  });
});

describe("two providers are one only by the same server under the same key", () => {
  it("one server and one key are the same, whatever the class", () => {
    expect(sends(RedactionValues.SameProvider, pair("p1/a", "p2/a"))).toBe(false); // other vendor
    expect(isSameProvider(used("p1/a", P1), used("p1/b", P2))).toBe(true);
  });

  it("a key, a base URL, the variable of the base URL or a header that differs is another provider", () => {
    expect(isSameProvider(used("p1/a", P1), used("p1/b", P3))).toBe(false);
    expect(isSameProvider(used("p1/a", P1), used("p1/b", P4))).toBe(false);
    expect(isSameProvider(used("p1/a", P1), used("p1/b", P5))).toBe(false);
    expect(isSameProvider(used("p1/a", P1), used("p1/b", P6))).toBe(false);
  });

  it("the same class is the same provider, even with no key; two classes with none are not", () => {
    expect(isSameProvider(used("k/a", Keyless), used("k/b", Keyless))).toBe(true);
    expect(isSameProvider(used("k/a", Keyless), used("k/b", P2))).toBe(false);
  });

  it("a model with a vendor is not a model without one, even a bare '/' away", () => {
    expect(isSameProvider(used("m", Keyless), used("m", Keyless))).toBe(true);
    expect(isSameProvider(used("m", Keyless), used("/m", Keyless))).toBe(false);
    expect(isSameProvider(used("/m", Keyless), used("m", Keyless))).toBe(false);
    expect(isSameProvider(used("/m", Keyless), used("/m", Keyless))).toBe(true);
  });

  it("providers that are no driver are never the same server, whatever fields they carry alike", () => {
    const transport = (type: ModelProviderType): RegisteredModelProvider => ({
      ...registeredOf(type),
      options: { ...modelProviderOf(P1), driver: undefined },
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
