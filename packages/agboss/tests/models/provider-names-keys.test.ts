/**
 * #266 S73 c, decided for PR 2: (1) a provider's key is a `Secret` field of the application's typed
 * environment (`apiKey: "openRouterApiKey"`, `secret("OPENROUTER_API_KEY")`), never a process
 * variable read by the provider; (2) a provider's `name` ends with `-model-provider`
 * (`[name.kind-suffix]`), the built-ins' too.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { EnvironmentError } from "../../src/environments/errors.js";
import {
  NO_ENVIRONMENT_VALUES,
  resolveEnvironment,
  SecretResolution,
} from "../../src/environments/resolve.js";
import { Secret, secret } from "../../src/environments/secret.js";
import { env } from "../../src/environments/variables.js";
import { EmptyEnvironment, GraphRuleError } from "../../src/index.js";
import {
  DecisionsModelProvider,
  ModelProvider,
  OpenAiCompatibleProvider,
  OpenRouterModelProvider,
  type NoRequestFields,
} from "../../src/models/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { providerBaseUrlOf, providerKeyOf } from "../../src/models/provider-environment.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { LocalWorkflow } from "./fixtures/resolution.workflow.js";
import { KEYS } from "./gateway.js";
import { LocalModelProvider, TestOpenRouterProvider } from "./providers.fixture.js";

@ModelProvider({ ...modelProviderOf(LocalModelProvider), name: "local" })
class LocalServer extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

@Application({
  name: "badly-named-provider-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LocalWorkflow],
  providers: [LocalServer, DecisionsModelProvider],
  budgets: TEST_BUDGETS,
})
class BadlyNamedProviderApplication {}

describe("#266 S73 c: provider names take the kind suffix", () => {
  it("a listed provider whose name lacks -model-provider fails the assembly", async () => {
    const error: unknown = await applicationOf(BadlyNamedProviderApplication).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphRuleError);
    expect(error instanceof GraphRuleError ? error.violations : []).toEqual([
      expect.objectContaining({
        code: "name.kind-suffix",
        message: '"local" on @ModelProvider — name it "local-model-provider"',
      }),
    ]);
  });

  it("the built-ins are named openrouter-model-provider and decisions-model-provider", () => {
    expect(
      [OpenRouterModelProvider, DecisionsModelProvider].map((cls) => modelProviderOf(cls).name),
    ).toEqual(["openrouter-model-provider", "decisions-model-provider"]);
  });
});

describe("#266 S73 c: a provider's key comes from the application's environment", () => {
  const openRouter = modelProviderOf(TestOpenRouterProvider);
  const NONE = { environment: NO_ENVIRONMENT_VALUES, env: { OPENROUTER_API_KEY: "not read" } };

  it("apiKey names a Secret field: its value is read from the resolved environment", () => {
    expect(openRouter.apiKey).toBe("openRouterApiKey");
    expect(providerKeyOf(openRouter, { environment: KEYS, env: {} }, true)).toBe("k");
    expect(modelProviderOf(OpenRouterModelProvider).apiKey).toBe("openRouterApiKey");
    expect(modelProviderOf(DecisionsModelProvider).apiKey).toBe("openRouterApiKey");
  });

  it("a missing key fails when the provider will be called, naming the field — never a process variable", () => {
    expect(() => providerKeyOf(openRouter, NONE, true)).toThrow(EnvironmentError);
    expect(() => providerKeyOf(openRouter, NONE, true)).toThrow(
      "openrouter-model-provider reads its key from the application's environment: the environment has no openRouterApiKey",
    );
    expect(providerKeyOf(openRouter, NONE, false)).toBeUndefined();
  });

  it("a key that is not a Secret is refused: keys are set with secret(…)", () => {
    const plain = resolveEnvironment(
      { name: "test", contract: "PlainEnvironment", values: { openRouterApiKey: "sk-plain" } },
      {},
    );
    const unresolved = resolveEnvironment(
      { name: "test", contract: "OtherEnvironment", values: { other: secret("OTHER") } },
      { OTHER: "x" },
    );

    expect(() => providerKeyOf(openRouter, { environment: plain, env: {} }, true)).toThrow(
      'openRouterApiKey is not a Secret — set it with secret("…")',
    );
    expect(() => providerKeyOf(openRouter, { environment: unresolved, env: {} }, true)).toThrow(
      "has no openRouterApiKey",
    );
  });

  it("an environment as written (its secret not resolved yet) takes the secret's own variable", () => {
    const environment = {
      ...NO_ENVIRONMENT_VALUES,
      openRouterApiKey: secret("OPENROUTER_API_KEY"),
    };

    expect(
      providerKeyOf(openRouter, { environment, env: { OPENROUTER_API_KEY: "k2" } }, true),
    ).toBe("k2");
    expect(() =>
      providerKeyOf(openRouter, { environment, env: { OPENROUTER_API_KEY: "" } }, true),
    ).toThrow(EnvironmentError);
  });

  it("a provider without apiKey (a local server) needs no key", () => {
    expect(providerKeyOf(modelProviderOf(LocalModelProvider), NONE, true)).toBe(undefined);
  });
});

describe("#266: a provider's base URL comes from the application's environment too", () => {
  const openRouter = modelProviderOf(OpenRouterModelProvider);
  const of = (values: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv = {}) =>
    providerBaseUrlOf(openRouter, {
      environment: resolveEnvironment({ name: "test", contract: "C", values }, env),
      env,
    });

  it("baseUrlField names a text field; the environment's value wins, else baseUrl", () => {
    expect(openRouter).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      baseUrlField: "openRouterBaseUrl",
    });
    expect(of({ openRouterBaseUrl: "http://proxy.test/v1" })).toBe("http://proxy.test/v1");
    expect(of({})).toBe("https://openrouter.ai/api/v1");
    expect(
      of(
        { openRouterBaseUrl: env("OPENROUTER_BASE_URL", { default: "http://d.test" }) },
        { OPENROUTER_BASE_URL: "http://stub.test/v1" },
      ),
    ).toBe("http://stub.test/v1");
  });

  it("S87: env.optional, no default — unset → the decorator's baseUrl; set → that value", () => {
    const declared = { openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL") };

    expect(of(declared)).toBe("https://openrouter.ai/api/v1");
    expect(of(declared, { OPENROUTER_BASE_URL: "" })).toBe("https://openrouter.ai/api/v1");
    expect(of(declared, { OPENROUTER_BASE_URL: "http://proxy.test/v1" })).toBe(
      "http://proxy.test/v1",
    );
    const written = { ...NO_ENVIRONMENT_VALUES, ...declared };
    expect(providerBaseUrlOf(openRouter, { environment: written, env: {} })).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("an environment as written: an env(…) reference takes its variable, else its default", () => {
    const written = {
      ...NO_ENVIRONMENT_VALUES,
      openRouterBaseUrl: env("OPENROUTER_BASE_URL", { default: "http://default.test/v1" }),
    };

    expect(providerBaseUrlOf(openRouter, { environment: written, env: {} })).toBe(
      "http://default.test/v1",
    );
    expect(
      providerBaseUrlOf(openRouter, {
        environment: written,
        env: { OPENROUTER_BASE_URL: "http://set.test/v1" },
      }),
    ).toBe("http://set.test/v1");
    expect(
      providerBaseUrlOf(modelProviderOf(LocalModelProvider), { environment: written, env: {} }),
    ).toBe("http://local.test/v1");
  });
});

describe("#266: resolving an environment's shape without its secrets", () => {
  const loaded = { name: "dev", contract: "C", values: { key: secret("KEY"), url: env("URL") } };

  it("Deferred keeps a secret whose variable is unset; other variables are still required", () => {
    const shaped = resolveEnvironment(loaded, { URL: "http://u.test" }, SecretResolution.Deferred);

    expect(Reflect.get(shaped, "key")).toBeInstanceOf(Secret);
    expect(() => resolveEnvironment(loaded, {}, SecretResolution.Deferred)).toThrow(
      "URL is not set (C.url, dev)",
    );
    expect(() => resolveEnvironment(loaded, { URL: "http://u.test" })).toThrow(
      "KEY is not set (C.key, dev)",
    );
  });
});
