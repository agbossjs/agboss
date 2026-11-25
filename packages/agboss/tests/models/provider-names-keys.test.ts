/**
 * #266 S73 c, decided for PR 2: (1) a provider's key is a `Secret` field of the application's typed
 * environment (`apiKey: "openRouterApiKey"`, `secret("OPENROUTER_API_KEY")`), never a process
 * variable read by the provider; (2) a provider's `name` ends with `-model-provider`
 * (`[name.not-kebab-case]`), the built-ins' too.
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
import { env } from "../../src/environments/env-readers.js";
import { EmptyEnvironment, GraphRuleError } from "../../src/index.js";
import { ModelProvider, OpenAiCompatibleDriver } from "../../src/models/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { providerBaseUrlOf, providerKeyOf } from "../../src/models/provider-environment.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { LocalWorkflow } from "./fixtures/resolution.workflow.js";
import { KEYS } from "./gateway.js";
import {
  driverOptionsOf,
  LocalModelProvider,
  TestDecisionsProvider,
  TestOpenRouterProvider,
} from "./providers.fixture.js";

@ModelProvider({ ...driverOptionsOf(LocalModelProvider), name: "Local_Server" })
class LocalServer {}

@ModelProvider({
  ...driverOptionsOf(LocalModelProvider),
  name: "proxied-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: env("LOCAL_URL") }),
})
class ProxiedServer {}

@Application({
  name: "badly-named-provider-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LocalWorkflow],
  providers: [LocalServer, TestDecisionsProvider],
  budgets: TEST_BUDGETS,
})
class BadlyNamedProviderApplication {}

describe("#266 S73 c: provider names are kebab-case", () => {
  it("a listed provider whose name is not kebab-case fails the assembly", async () => {
    const error: unknown = await applicationOf(BadlyNamedProviderApplication).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphRuleError);
    expect(error instanceof GraphRuleError ? error.violations : []).toEqual([
      expect.objectContaining({
        code: "name.not-kebab-case",
        message: '"Local_Server" on @ModelProvider — a name is kebab-case: "local-server"',
      }),
    ]);
  });

  it("the built-ins are named openrouter-model-provider and decisions-model-provider", () => {
    expect(
      [TestOpenRouterProvider, TestDecisionsProvider].map((cls) => modelProviderOf(cls).name),
    ).toEqual(["openrouter-model-provider", "decisions-model-provider"]);
  });
});

describe("#1313: a driver provider's key and base URL are references read from the process", () => {
  const openRouter = modelProviderOf(TestOpenRouterProvider);
  const source = (env: NodeJS.ProcessEnv) => ({ environment: NO_ENVIRONMENT_VALUES, env });

  it("secret(…) is read from its variable: the value, never a field of the environment", () => {
    expect(providerKeyOf(openRouter, source({ OPENROUTER_API_KEY: "k2" }), true)).toBe("k2");
  });

  it("a missing key fails when the provider will be called, naming the variable", () => {
    expect(() => providerKeyOf(openRouter, source({}), true)).toThrow(EnvironmentError);
    expect(() => providerKeyOf(openRouter, source({}), true)).toThrow("OPENROUTER_API_KEY");
    expect(providerKeyOf(openRouter, source({}), false)).toBeUndefined();
    expect(() => providerKeyOf(openRouter, source({ OPENROUTER_API_KEY: "" }), true)).toThrow(
      EnvironmentError,
    );
  });

  it("a provider without apiKey (a local server) needs no key", () => {
    expect(providerKeyOf(modelProviderOf(LocalModelProvider), source({}), true)).toBe(undefined);
  });

  it("the base URL is the driver's text, or the variable an env(…) names", () => {
    expect(providerBaseUrlOf(openRouter, source({}))).toBe("http://openrouter.test/api/v1");
    expect(providerBaseUrlOf(modelProviderOf(LocalModelProvider), source({}))).toBe(
      "http://local.test/v1",
    );
    const proxied = modelProviderOf(ProxiedServer);

    expect(providerBaseUrlOf(proxied, source({ LOCAL_URL: "http://stub.test/v1" }))).toBe(
      "http://stub.test/v1",
    );
    expect(() => providerBaseUrlOf(proxied, source({}))).toThrow(EnvironmentError);
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
