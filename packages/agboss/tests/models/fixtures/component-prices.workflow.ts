import {
  Agent,
  DecidedBy,
  EmptyEnvironment,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  Ttl,
  type Class,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { ModelCost, ModelProvider, OpenAiCompatibleDriver } from "../../../src/models/index.js";
import {
  Rag,
  RagReranker,
  RagScope,
  RagSource,
  RerankFailurePolicy,
  type RagRetrieval,
} from "../../../src/rag/index.js";
import { seconds, usd } from "../../../src/units/index.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import { Budget, BudgetScope, type BudgetHandler } from "../../../src/budgets/budget.js";
import type { Usd } from "../../../src/units/index.js";
import { onStart, toAgent } from "../../helpers/flow.js";

/**
 * Bughunt 2026-11-25 #2: a model-backed component that is no agent, judge or compaction — a model
 * router, a model reranker — on a provider whose `cost` is a price table. Its call is priced by its
 * own provider's table for its own model, never by an agent's price for a model of the same name on
 * another provider; a provider with no `cost` makes its calls unpriced tokens. Every provider is an
 * OpenAI-compatible HTTP server the test stubs (one queue of answers, in call order).
 */

/** USD per 1M tokens of each model the priced server serves. */
export const PRICES = {
  agent: { input: 1, output: 2 },
  router: { input: 10, output: 20 },
  rerank: { input: 100, output: 200 },
} as const;

/** The priced server: its own table prices every model it serves. */
@ModelProvider({
  name: "priced-local-model-provider",
  description: "A local server with a price table",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://priced.test/v1" }),
  timeout: seconds(10),
  cost: ModelCost.fromPrices({
    "p/agent": {
      inputPerMillion: usd(PRICES.agent.input),
      outputPerMillion: usd(PRICES.agent.output),
    },
    "p/router": {
      inputPerMillion: usd(PRICES.router.input),
      outputPerMillion: usd(PRICES.router.output),
    },
    "p/rerank": {
      inputPerMillion: usd(PRICES.rerank.input),
      outputPerMillion: usd(PRICES.rerank.output),
    },
  }),
})
export class PricedLocalProvider {}

/** Another server that serves a model of the same name, `p/router`, at its own (much higher) price. */
@ModelProvider({
  name: "other-priced-model-provider",
  description: "Another server with a price table",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://other.test/v1" }),
  timeout: seconds(10),
  cost: ModelCost.fromPrices({
    "p/router": { inputPerMillion: usd(1000), outputPerMillion: usd(2000) },
  }),
})
export class OtherPricedProvider {}

/** A server that bills nothing (a subscription): no `cost`, its calls are unpriced tokens. */
@ModelProvider({
  name: "bare-local-model-provider",
  description: "A local server that bills nothing",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://bare.test/v1" }),
  timeout: seconds(10),
})
export class BareLocalProvider {}

/** A server whose answers must report their cost: one that does not cannot be priced. */
@ModelProvider({
  name: "reporting-model-provider",
  description: "A server that reports each call's cost",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://reporting.test/v1" }),
  timeout: seconds(10),
  cost: ModelCost.fromResponse(),
})
export class ReportingProvider {}

/** The application's daily budgets and an execution budget of `maxSpend` ($1 when none is asked for). */
function budgetsOf(maxSpend: Usd = usd(1)): readonly Class[] {
  const limit: Usd = maxSpend;
  @Budget({ name: "component-prices-execution-budget", scope: BudgetScope.Execution })
  class ComponentPricesExecutionBudget implements BudgetHandler {
    maxSpend(): Usd {
      return limit;
    }
  }
  return [TestApplicationDailyBudget, TestTenantDailyBudget, ComponentPricesExecutionBudget];
}

/** A model router on `router` (its own provider) between an agent on the priced server and `other`. */
export function routerApplication(
  router: Class,
  options: { readonly withOther?: boolean; readonly maxSpend?: Usd } = {},
): { readonly application: Class; readonly start: Class } {
  @Agent({
    name: "priced-answer-agent",
    description: "Answers",
    prompt: inline("Answer."),
    model: "p/agent",
    modelProvider: PricedLocalProvider,
    input: { message: WorkflowStartTextDto },
  })
  class PricedAnswerAgent {}

  // the same model name `p/router` on another provider, at another price
  @Agent({
    name: "other-answer-agent",
    description: "Answers elsewhere",
    prompt: inline("Answer."),
    model: "p/router",
    modelProvider: OtherPricedProvider,
    input: { message: WorkflowStartTextDto },
  })
  class OtherAnswerAgent {}

  @Router({
    name: "priced-router",
    description: "Picks who answers",
    decidedBy: DecidedBy.Model,
    prompt: inline("Pick who answers."),
    model: "p/router",
    modelProvider: router,
    input: { message: WorkflowStartTextDto },
    routes: [
      { prompt: "Here", target: PricedAnswerAgent },
      { prompt: "Elsewhere", target: options.withOther === true ? OtherAnswerAgent : StopAgent },
    ],
  })
  class PricedRouter {}

  @WorkflowStart({
    name: "router-prices-workflow-start",
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class RouterStart {}

  @WorkflowFinish({
    name: "router-prices-workflow-finish",
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class RouterFinish {}

  const other = options.withOther === true ? OtherAnswerAgent : StopAgent;

  @Workflow({
    name: "router-prices-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(RouterStart)
        .toRouter(PricedRouter)
        .onRoute(
          toAgent(PricedAnswerAgent)
            .toFinish(RouterFinish),
        )
        .onRoute(
          toAgent(other)
            .toFinish(RouterFinish),
        ),
    ],
  })
  class RouterPricesWorkflow {}

  @Application({
    name: "router-prices-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [RouterPricesWorkflow],
    providers: [PricedLocalProvider, OtherPricedProvider, BareLocalProvider, ReportingProvider],
    budgets: budgetsOf(options.maxSpend),
  })
  class RouterPricesApplication {}

  return { application: RouterPricesApplication, start: RouterStart };
}

/** The other route when no agent of another provider is wanted: an agent on the priced server. */
@Agent({
  name: "stop-agent",
  description: "Stops",
  prompt: inline("Stop."),
  model: "p/agent",
  modelProvider: PricedLocalProvider,
  input: { message: WorkflowStartTextDto },
})
class StopAgent {}

/** The two candidates every knowledge base retrieves. */
class TwoCandidates extends RagSource {
  protected override retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({
      results: [
        { source: "a.md", text: "Alpha." },
        { source: "b.md", text: "Beta." },
      ],
    });
  }
}

/** An agent reading a knowledge base reranked by a model reranker on `provider`'s `model`. */
export function rerankerApplication(
  provider: Class,
  model: string,
  onFailure: RerankFailurePolicy = RerankFailurePolicy.FailStep,
): { readonly application: Class; readonly start: Class } {
  @RagReranker({
    name: "priced-reranker",
    description: "Reranks on a model",
    candidates: 2,
    model,
    modelProvider: provider,
    onFailure,
  })
  class PricedReranker {}

  @Rag({
    name: "priced-rag",
    description: "Docs",
    scope: RagScope.Tenant,
    topK: 2,
    reranker: PricedReranker,
  })
  class PricedRag extends TwoCandidates {}

  // the agent calls the reranker's model on the same server: its price is no help to the reranker
  @Agent({
    name: "reading-agent",
    description: "Answers from the docs",
    prompt: inline("Answer from the docs."),
    model: "p/agent",
    modelProvider: PricedLocalProvider,
    input: { message: WorkflowStartTextDto },
    rag: [PricedRag],
  })
  class ReadingAgent {}

  @WorkflowStart({
    name: "rerank-prices-workflow-start",
    description: "A question",
    input: WorkflowStartTextDto,
  })
  class RerankStart {}

  @WorkflowFinish({
    name: "rerank-prices-workflow-finish",
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class RerankFinish {}

  @Workflow({
    name: "rerank-prices-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(RerankStart)
        .toAgent(ReadingAgent)
        .toFinish(RerankFinish),
    ],
  })
  class RerankPricesWorkflow {}

  @Application({
    name: "rerank-prices-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [RerankPricesWorkflow],
    providers: [PricedLocalProvider, BareLocalProvider],
    budgets: budgetsOf(undefined),
  })
  class RerankPricesApplication {}

  return { application: RerankPricesApplication, start: RerankStart };
}
