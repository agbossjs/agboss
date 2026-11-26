/**
 * Bughunt 2026-11-25 (regressions):
 * - #1: two `@ModelProvider` classes of one `name` — a model use resolves to its provider's name, so a
 *   component naming the second class had its prompt sent to the first one's upstream with the first
 *   one's key. Assembly refuses it with `[model.duplicate-provider-name]`, and the directory never
 *   picks one of two providers of a name.
 * - #5: a driver's options were never checked for unknown keys — `baseURL` (the OpenAI SDK's spelling)
 *   left `baseUrl` at the default, so a proxy's key and every prompt went to public openrouter.ai.
 *   Each driver factory has its allowed keys; a stray one is `[decorator.unknown-option]` at assembly.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { Application } from "../../src/application/application.js";
import {
  Agent,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  Ttl,
  type Class,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { secret } from "../../src/environments/secret.js";
import {
  DecisionsDriver,
  ModelCost,
  ModelKind,
  ModelProvider,
  OpenAiCompatibleDriver,
  OpenRouterDriver,
} from "../../src/models/index.js";
import { ModelProviderDirectory } from "../../src/models/resolve.js";
import { seconds } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import { appWithKeys } from "./gateway.js";
import { completion, providerStub } from "./stub.js";

@ModelProvider({
  name: "shared-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://a.test/v1", apiKey: secret("A_KEY") }),
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
})
class ProviderA {}

@ModelProvider({
  name: "shared-model-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://b.test/v1", apiKey: secret("B_KEY") }),
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
})
class ProviderB {}

/** An application whose one agent is served by `provider`, the application listing `listed`. */
function applicationOn(provider: Class, listed: readonly Class[]): Class {
  @Agent({
    name: "named-agent",
    description: "Answers",
    prompt: inline("Answer."),
    model: "x/model",
    modelProvider: provider,
    input: { message: WorkflowStartTextDto },
  })
  class NamedAgent {}

  @WorkflowStart({
    name: "named-workflow-start",
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class NamedStart {}

  @WorkflowFinish({
    name: "named-workflow-finish",
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class NamedFinish {}

  @Workflow({
    name: "named-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(NamedStart).toAgent(NamedAgent).toFinish(NamedFinish)],
  })
  class NamedWorkflow {}

  @Application({
    name: "named-application",
    version: "1.0.0",
    workflows: [NamedWorkflow],
    providers: listed,
    budgets: TEST_BUDGETS,
  })
  class NamedApplication {}
  return NamedApplication;
}

async function violationsOf(application: Class): Promise<readonly (readonly [string, string])[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ConfigError.GraphRules))
    throw new Error(`expected a ConfigError.GraphRules, got ${String(error)}`);
  return error.violations.map((found) => [found.code, found.message] as const);
}

describe("bughunt #1: two model providers of one name", () => {
  it("both listed, the agent naming the second: [model.duplicate-provider-name], no call is sent", async () => {
    const stub = providerStub([completion("from a")], [{ id: "x/model" }]);
    const started = appWithKeys(applicationOn(ProviderB, [ProviderA, ProviderB]), {
      processEnv: { A_KEY: "key-a", B_KEY: "key-b" },
      providerFetch: stub.fetch,
    });

    await expect(started).rejects.toThrow(ConfigError.GraphRules);
    await expect(started).rejects.toThrow(/\[model\.duplicate-provider-name\]/u);
    expect(stub.requests).toEqual([]);
  });

  it("names the name and both classes", async () => {
    expect(await violationsOf(applicationOn(ProviderB, [ProviderA, ProviderB]))).toContainEqual([
      "model.duplicate-provider-name",
      "shared-model-provider names ProviderA and ProviderB — each @ModelProvider needs its own name",
    ]);
  });

  it("one listed, the other named only by the component: refused too", async () => {
    const codes = (await violationsOf(applicationOn(ProviderB, [ProviderA]))).map(([code]) => code);

    expect(codes).toContain("model.duplicate-provider-name");
  });

  it("the directory never picks one of two providers of a name", () => {
    const directory = ModelProviderDirectory.of([ProviderA, ProviderB]);

    expect(
      directory.resolve({
        key: "agents.named-agent",
        model: "x/model",
        purpose: ModelKind.Chat,
        modelProvider: "shared-model-provider",
      }),
    ).toMatchObject({ kind: "problem", problem: { code: "model.duplicate-provider-name" } });
    expect(directory.named("shared-model-provider")).toBeUndefined();
  });
});

/** An application on a provider whose driver is `driver`. */
function applicationOfDriver(driver: ReturnType<typeof OpenRouterDriver>): Class {
  @ModelProvider({ name: "typo-model-provider", driver, timeout: seconds(5) })
  class TypoProvider {}
  return applicationOn(TypoProvider, [TypoProvider]);
}

const untyped = (options: object): never => options as never;

describe("bughunt #5: a driver's unknown option", () => {
  it("OpenRouterDriver({ baseURL }): [decorator.unknown-option], did you mean baseUrl — no key reaches openrouter.ai", async () => {
    const driver = OpenRouterDriver(
      untyped({ apiKey: secret("PROXY_KEY"), baseURL: "http://proxy.internal/v1" }),
    );
    const stub = providerStub([completion()], [{ id: "x/model" }]);
    const started = appWithKeys(applicationOfDriver(driver), {
      processEnv: { PROXY_KEY: "proxy-secret" },
      providerFetch: stub.fetch,
    });

    await expect(started).rejects.toThrow(ConfigError.GraphRules);
    expect(stub.requests).toEqual([]);
    expect(await violationsOf(applicationOfDriver(driver))).toContainEqual([
      "decorator.unknown-option",
      "TypoProvider (typo-model-provider): baseURL is not an option of OpenRouterDriver(…) (in @ModelProvider driver) — did you mean baseUrl?",
    ]);
  });

  it("a stray key of OpenRouter's routing is named in its bag", async () => {
    const driver = OpenRouterDriver(
      untyped({ apiKey: secret("PROXY_KEY"), routing: { ignored: ["x"] } }),
    );

    expect(await violationsOf(applicationOfDriver(driver))).toContainEqual([
      "decorator.unknown-option",
      "TypoProvider (typo-model-provider): ignored is not an option of OpenRouterDriver(…) (in routing of @ModelProvider driver) — did you mean ignore?",
    ]);
  });

  it("OpenAiCompatibleDriver({ apikey }) and DecisionsDriver({ knownModel }) are refused alike", async () => {
    const openAi = OpenAiCompatibleDriver(
      untyped({ baseUrl: "http://llm.test/v1", apikey: secret("LLM_KEY") }),
    );
    const decisions = DecisionsDriver(untyped({ baseUrl: "http://d.test", knownModel: ["j"] }));

    expect(await violationsOf(applicationOfDriver(openAi))).toContainEqual([
      "decorator.unknown-option",
      "TypoProvider (typo-model-provider): apikey is not an option of OpenAiCompatibleDriver(…) (in @ModelProvider driver) — did you mean apiKey?",
    ]);
    const codes = (await violationsOf(applicationOfDriver(decisions as never))).map(([c]) => c);
    expect(codes).toContain("decorator.unknown-option");
  });

  it("a stray key is never kept in the driver's settings; the declared ones are", () => {
    const driver = OpenRouterDriver(
      untyped({ apiKey: secret("PROXY_KEY"), baseURL: "http://proxy.internal/v1" }),
    );

    expect(Object.keys(driver.settings).sort()).toEqual(["apiKey", "baseUrl"]);
    expect(driver.settings.baseUrl).toBe("https://openrouter.ai/api/v1");
  });
});
