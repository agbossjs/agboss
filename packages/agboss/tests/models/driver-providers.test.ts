import { ConfigError } from "../../src/core/error-families/config-errors.js";
/**
 * #1313a: a `@ModelProvider({ driver })` is an independent class; a component's model is served by
 * the provider its cascade names (`Component.modelProvider ?? Workflow.modelProvider ??
 * Application.modelProvider`), a role (`"fast"`) maps through the provider's `models`.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import { createProviderGateway } from "../../src/llm/gateway.js";
import {
  DecisionsDriver,
  ModelKind,
  ModelProvider,
  OpenAiCompatibleDriver,
  OpenRouterDriver,
} from "../../src/models/index.js";
import { modelNamedBy } from "../../src/models/model-cascade.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { ModelProviderDirectory } from "../../src/models/resolve.js";
import { resolveEnvironment } from "../../src/environments/resolve.js";
import { execute } from "../helpers/flow.js";
import { appWithKeys, instanceCalls } from "./gateway.js";
import { completion, providerStub } from "./stub.js";
import {
  AppChatModels,
  BareApplication,
  BareChatModels,
  DecisionModels,
  DecisionProviderApplication,
  DriversApplication,
  FastStart,
  NoProviderApplication,
  SingleModelProvider,
  UnlistedApplication,
} from "./fixtures/driver-providers.workflow.js";

const EMPTY = resolveEnvironment({ name: "test", contract: "Empty", values: {} }, {});

async function violationsOf(application: Class): Promise<(readonly [string, string])[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ConfigError.GraphRules))
    throw new Error(`expected a ConfigError.GraphRules: ${String(error)}`);
  return error.violations.map((found) => [found.code, found.message] as const);
}

describe("#1313a: the model cascade", () => {
  it("resolves every agent through Component → Workflow → Application, roles to the vendor's names", async () => {
    const { workflows } = await applicationOf(DriversApplication);
    const agents = Object.assign(
      {},
      ...workflows.map((workflow) => workflow.config.agents),
    ) as Record<string, unknown>;

    expect(agents["fast-agent"]).toMatchObject({
      model: "vendor/small",
      modelProvider: "app-chat-models",
    });
    // no model named: the provider's models.default
    expect(agents["plain-agent"]).toMatchObject({
      model: "vendor/big",
      modelProvider: "app-chat-models",
    });
    // the component's own provider wins over the application's, and names its single model
    expect(agents["own-agent"]).toMatchObject({
      model: "router/only",
      modelProvider: "single-model-provider",
    });
    // a model that is no role goes to the server as written
    expect(agents["literal-agent"]).toMatchObject({
      model: "vendor/literal",
      modelProvider: "app-chat-models",
    });
  });

  it("a provider the cascade names is part of the application though no providers list has it", async () => {
    const { workflows } = await applicationOf(UnlistedApplication);

    expect(workflows.map((workflow) => workflow.modelProviders)).toEqual([
      [AppChatModels],
      [AppChatModels, SingleModelProvider],
    ]);
  });

  it("[model.missing]: no model named and the provider has neither model nor models.default", async () => {
    expect(await violationsOf(BareApplication)).toEqual([
      [
        "model.missing",
        "bare-workflow agents.plain-agent: names no model and bare-chat-models has no model or models.default — set model on the component or on the provider",
      ],
    ]);
  });

  it("[model.missing-provider]: a driver provider is listed and no cascade level names one", async () => {
    const violations = await violationsOf(NoProviderApplication);

    expect(violations.map(([code]) => code)).toEqual(["model.missing-provider"]);
    expect(violations[0]?.[1]).toContain("agents.fast-agent");
    expect(violations[0]?.[1]).toContain("set modelProvider on the component");
  });

  it("[model.incompatible-provider]: a chat agent on a provider with a decisions driver", async () => {
    const violations = await violationsOf(DecisionProviderApplication);

    expect(violations.map(([code]) => code)).toEqual(["model.incompatible-provider"]);
    expect(violations[0]?.[1]).toContain("decision-models does not serve chat models");
  });
});

describe("#1313a: model roles", () => {
  const options = modelProviderOf(AppChatModels);
  const single = modelProviderOf(SingleModelProvider);
  const bare = modelProviderOf(BareChatModels);

  it("a role maps through models; the default role is models.default, else model", () => {
    expect(modelNamedBy(options, "fast")).toBe("vendor/small");
    expect(modelNamedBy(options, undefined)).toBe("vendor/big");
    expect(modelNamedBy(options, "default")).toBe("vendor/big");
    expect(modelNamedBy(single, undefined)).toBe("router/only");
  });

  it("a name that is no role is the vendor's name as written; the default of a bare provider is nothing", () => {
    expect(modelNamedBy(options, "vendor/literal")).toBe("vendor/literal");
    expect(modelNamedBy(bare, undefined)).toBeUndefined();
    expect(modelNamedBy(bare, "x/y")).toBe("x/y");
  });
});

describe("#1313a: drivers and the directory", () => {
  it("a driver provider says what it serves: chat or decisions, never by a model's name", () => {
    const directory = ModelProviderDirectory.of([AppChatModels, DecisionModels]);
    const query = { key: "agents.a", model: "vendor/big" };

    expect(
      directory.resolve({ ...query, purpose: ModelKind.Chat, modelProvider: "app-chat-models" }),
    ).toMatchObject({ kind: "resolved" });
    expect(
      directory.resolve({
        ...query,
        purpose: ModelKind.Decisions,
        modelProvider: "decision-models",
      }),
    ).toMatchObject({ kind: "resolved" });
    expect(
      directory.resolve({
        ...query,
        purpose: ModelKind.Decisions,
        modelProvider: "app-chat-models",
      }),
    ).toMatchObject({
      kind: "problem",
      problem: { code: "model.incompatible-provider" },
    });
    expect(
      directory.resolve({ ...query, purpose: ModelKind.Chat, modelProvider: "nobody" }),
    ).toMatchObject({
      kind: "problem",
      problem: { code: "model.missing-provider" },
    });
    // no provider named and none serves it by name: a driver provider never claims a model
    expect(directory.resolve({ ...query, purpose: ModelKind.Chat })).toMatchObject({
      kind: "problem",
      problem: { code: "model.missing-provider" },
    });
  });

  it("the decorator takes only a driver an OpenAiCompatibleDriver(…) made", () => {
    const literal = { kind: ModelKind.Chat } as never;

    expect(() =>
      ModelProvider({
        driver: literal,
        timeout: 1 as never,
        cost: undefined,
        retryPolicy: undefined,
        circuitBreakerPolicy: undefined,
      }),
    ).toThrow(ConfigError.ModelProvider);
  });

  it("the kind of a driver: OpenAI-compatible and OpenRouter chat, Decisions decide", () => {
    expect(OpenAiCompatibleDriver({ baseUrl: "http://a" }).kind).toBe(ModelKind.Chat);
    expect(OpenRouterDriver({ apiKey: undefined as never }).kind).toBe(ModelKind.Chat);
    expect(DecisionsDriver({ baseUrl: "http://a" }).kind).toBe(ModelKind.Decisions);
  });
});

describe("#1313a: a driver's connection", () => {
  const settings = {
    env: { LLM_URL: "http://llm.test/v1", LLM_KEY: "sk-1", LLM_TOKEN: "tok-1", OR_KEY: "or-1" },
    environment: EMPTY,
    calls: instanceCalls(),
  };

  it("an OpenAI-compatible call: the key and headers from the process, no OpenRouter-only X-Title", async () => {
    const stub = providerStub([completion("hello", 0.001)]);
    const gateway = createProviderGateway(ModelProviderDirectory.of([AppChatModels]), {
      ...settings,
      send: stub.fetch,
    });

    await gateway
      .chatModel({
        user: { kind: "agent", agent: "a" },
        settings: {
          model: "vendor/small",
          temperature: 0,
          maxTokens: 10,
          modelProvider: "app-chat-models",
        },
      })
      .invoke("hi");

    expect(stub.requests[0]).toMatchObject({
      url: "http://llm.test/v1/chat/completions",
      authorization: "Bearer sk-1",
    });
    expect(stub.requests.at(0)?.headers).toMatchObject({ "x-tenant": "acme", "x-token": "tok-1" });
    expect(stub.requests.at(0)?.headers["x-title"]).toBeUndefined();
  });

  it("a missing key fails naming the variable, never a value", () => {
    expect(() =>
      createProviderGateway(ModelProviderDirectory.of([AppChatModels]), {
        ...settings,
        env: { LLM_URL: "http://llm.test/v1", LLM_TOKEN: "tok-1" },
      }),
    ).toThrow(/LLM_KEY is not set/);
  });

  it("a decisions call without a key sends no Authorization header", async () => {
    const stub = providerStub([{ body: { answers: {}, usage: { cost: 0 } } }]);
    const gateway = createProviderGateway(ModelProviderDirectory.of([DecisionModels]), {
      ...settings,
      send: stub.fetch,
    });

    await gateway
      .decide({
        caller: "judge:j",
        model: "decide/one",
        modelProvider: "decision-models",
        request: { state: "x", questions: { q: { type: "boolean", instructions: "Is it?" } } },
      })
      .catch(() => undefined);

    expect(stub.requests.at(0)?.url).toBe("http://decide.test/alpha/decisions");
    expect(stub.requests.at(0)?.authorization).toBeNull();
  });

  it("the gateway tells what a provider speaks, and nothing for a provider not named", () => {
    const gateway = createProviderGateway(
      ModelProviderDirectory.of([AppChatModels, DecisionModels]),
      settings,
    );

    expect(gateway.kindOf?.("decision-models")).toBe(ModelKind.Decisions);
    expect(gateway.kindOf?.("app-chat-models")).toBe(ModelKind.Chat);
    expect(gateway.kindOf?.(undefined)).toBeUndefined();
  });
});

describe("#1313a: an app on driver providers", () => {
  it("a role goes to the server as the vendor's name, over the driver's URL, key and headers", async () => {
    const stub = providerStub(
      [completion("fast answer", 0.002)],
      [
        { id: "vendor/small" },
        { id: "vendor/big" },
        { id: "vendor/literal" },
        { id: "router/only" },
      ],
    );
    const app = await appWithKeys(DriversApplication, {
      processEnv: {
        LLM_URL: "http://llm.test/v1",
        LLM_KEY: "sk-1",
        LLM_TOKEN: "tok-1",
        OR_KEY: "or-1",
      },
      providerFetch: stub.fetch,
    });

    const result = await execute(app, FastStart, { text: "hello" });

    const chat = stub.requests.find((request) => request.url.endsWith("/chat/completions"));
    expect(chat).toMatchObject({
      url: "http://llm.test/v1/chat/completions",
      authorization: "Bearer sk-1",
      body: { model: "vendor/small" },
    });
    expect(chat?.headers["x-tenant"]).toBe("acme");
    expect(result.output).toBeDefined();
    await app.close();
  });
});
