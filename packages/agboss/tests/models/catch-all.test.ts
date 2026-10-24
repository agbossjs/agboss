/**
 * #454: the built-in catch-all providers — `OpenRouterModelProvider` (every chat model but the
 * decision models) and `DecisionsModelProvider` (every decision model) — serve their models except
 * those another listed provider claims by `serves`. A project's provider for its own prefix works
 * next to them with no narrowed copy (AC1); two providers of the project claiming one model stay
 * `[model.ambiguous-provider]` (AC2); a subclass of the built-in with its own `serves` claims like
 * any other provider.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { describeWorkflow } from "../../src/describe/describe-workflow.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Agent,
  EmptyEnvironment,
  GraphRuleError,
  TokenLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../src/index.js";
import {
  DecisionsModelProvider,
  ModelCost,
  ModelProvider,
  ModelProviderDirectory,
  ModelPurpose,
  OpenRouterModelProvider,
  OpenRouterProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderResponse,
  type OpenRouterFields,
} from "../../src/models/index.js";
import { minutes, seconds } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import { LocalMirrorModelProvider, LocalModelProvider } from "./providers.fixture.js";

/** A transport provider for its own prefix (#385), as flow-patterns' harness is. */
@ModelProvider({
  name: "harness-model-provider",
  description: "Answers the harness models offline",
  serves: [/^harness\//],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
class HarnessModelProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } });
  }
}

/** A subclass of the built-in with its own `serves`: an explicit claim, it does not yield. */
@ModelProvider({
  name: "wide-model-provider",
  description: "OpenRouter for every model",
  serves: [/.*/],
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "openRouterApiKey",
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
class WideModelProvider extends OpenRouterProvider {
  override readonly requestFields: OpenRouterFields = {};
}

@Agent({
  name: "harness-agent",
  description: "Answers on the harness",
  prompt: "Answer.",
  model: "harness/x",
})
class HarnessAgent {}

@Agent({
  name: "kimi-agent",
  description: "Answers on OpenRouter",
  prompt: "Answer.",
  model: "moonshotai/kimi-k2.6",
})
class KimiAgent {}

@WorkflowStart({
  name: "catch-all-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
class CatchAllStart {}

@WorkflowStart({
  name: "catch-all-kimi-workflow-start",
  description: "A message for OpenRouter",
  input: WorkflowStartTextDto,
})
class CatchAllKimiStart {}

@WorkflowFinish({
  name: "catch-all-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
class CatchAllFinish {}

@Workflow({
  name: "catch-all-workflow",
  version: "1.0.0",
  flow: [
    start(CatchAllStart)
      .returns(WorkflowStartTextDto)
      .toAgent(HarnessAgent)
      .toFinish(CatchAllFinish),
    start(CatchAllKimiStart)
      .returns(WorkflowStartTextDto)
      .toAgent(KimiAgent)
      .toFinish(CatchAllFinish),
  ],
  defaults: {
    models: { temperature: 0, maxTokens: TokenLimit.MODEL_MAX },
    router: { model: "typesafe/jev-1.13" },
  },
  uncompactedTurns: 1,
})
class CatchAllWorkflow {}

/** The built-ins listed by name next to the project's own transport. */
@Application({
  name: "catch-all-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CatchAllWorkflow],
  providers: [OpenRouterModelProvider, DecisionsModelProvider, HarnessModelProvider],
  budgets: TEST_BUDGETS,
})
class CatchAllApplication {}

const chat = (model: string) => ({ key: "agents.scout", model, purpose: ModelPurpose.Chat });

const providerOf = (directory: ModelProviderDirectory, query: ReturnType<typeof chat>): string => {
  const resolution = directory.resolve(query);
  return resolution.kind === "resolved"
    ? resolution.provider.options.name
    : `${resolution.problem.code}: ${resolution.problem.supported}`;
};

describe("#454 AC1: the built-ins yield to a provider that claims the model", () => {
  it("harness/x resolves to the transport, moonshotai/kimi-k2.6 to OpenRouter, Jev to Decisions", () => {
    const directory = ModelProviderDirectory.of([
      OpenRouterModelProvider,
      DecisionsModelProvider,
      HarnessModelProvider,
    ]);

    expect(providerOf(directory, chat("harness/x"))).toBe("harness-model-provider");
    expect(providerOf(directory, chat("moonshotai/kimi-k2.6"))).toBe("openrouter-model-provider");
    expect(
      providerOf(directory, { ...chat("typesafe/jev-1.13"), purpose: ModelPurpose.Decision }),
    ).toBe("decisions-model-provider");
  });

  it("the application assembles, and describe prints model → provider for each", async () => {
    const [workflow] = (await applicationOf(CatchAllApplication)).workflows;
    if (workflow === undefined) throw new Error("the application has a workflow");

    const lines = describeWorkflow(workflow);

    expect(lines.slice(lines.indexOf("models"), lines.indexOf("agents"))).toEqual([
      "models",
      "  agents.harness-agent  model: harness/x → harness-model-provider",
      "  agents.kimi-agent  model: moonshotai/kimi-k2.6 → openrouter-model-provider",
      "  defaults.router  model: typesafe/jev-1.13 → decisions-model-provider",
    ]);
  });

  it("the Decisions built-in yields too: a decision model another provider claims is its", () => {
    const directory = ModelProviderDirectory.of([OpenRouterModelProvider, DecisionsModelProvider]);
    const decision = { ...chat("typesafe/jev-1.13"), purpose: ModelPurpose.Decision };

    expect(providerOf(directory, decision)).toBe("decisions-model-provider");
    // a model neither serves stays unserved: yielding never invents a provider
    expect(providerOf(directory, chat("typesafe/jev-1.13"))).toContain("model.unserved");
  });
});

describe("#454 AC2: explicit claims stay exclusive", () => {
  it("two providers of the project claiming one model are ambiguous — the built-in is not named", () => {
    const directory = ModelProviderDirectory.of([
      OpenRouterModelProvider,
      LocalModelProvider,
      LocalMirrorModelProvider,
    ]);

    expect(providerOf(directory, chat("local/llama"))).toBe(
      "model.ambiguous-provider: served by several providers: local-model-provider, local-mirror-model-provider",
    );
  });

  it("a subclass of the built-in with its own serves claims like any provider", () => {
    const directory = ModelProviderDirectory.of([WideModelProvider, LocalModelProvider]);

    expect(providerOf(directory, chat("local/llama"))).toBe(
      "model.ambiguous-provider: served by several providers: wide-model-provider, local-model-provider",
    );
  });

  it("at assembly too: the same model on two of the project's providers fails with the built-ins listed", async () => {
    @Application({
      name: "catch-all-mirrored-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [CatchAllWorkflow],
      providers: [
        OpenRouterModelProvider,
        DecisionsModelProvider,
        HarnessModelProvider,
        MirrorHarnessModelProvider,
      ],
      budgets: TEST_BUDGETS,
    })
    class CatchAllMirroredApplication {}

    const error: unknown = await applicationOf(CatchAllMirroredApplication).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphRuleError);
    expect((error as GraphRuleError).violations.map((found) => found.code)).toEqual([
      "model.ambiguous-provider",
    ]);
  });
});

/** A second transport for the harness prefix: two explicit claims. */
@ModelProvider({
  name: "mirror-harness-model-provider",
  description: "Answers the harness models too",
  serves: [/^harness\//],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
class MirrorHarnessModelProvider implements ModelProviderHandler {
  complete(): Promise<ModelProviderResponse> {
    return Promise.resolve({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } });
  }
}
