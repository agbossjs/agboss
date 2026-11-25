# 03 — Components, DI and lifecycle

Read this when you write a component class, a service, a provider or a lifecycle hook, read the
execution or the environment, or run the application (`createApp`, `app.execute`, `app.cancel`).
Which primitive to pick: `01-composition-and-architecture.md`; the flow: `02-flow-dsl-all-combinations.md`.

## The decorators

| Decorator (file)                                                                                   | Its contract                                                                                                                    | Key options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Application` (`<app>.application.ts`)                                                            | —                                                                                                                               | `name`, `version`, `environment` (required), `workflows`, `budgets`, `storage` (`@DatabaseStorage`, …), `modelProvider`, `providers` (infrastructure, model providers), `services`, `channels` / `channelSelectors` / `channelListeners`, `endpoints` (`@A2AEndpoint`), `mesh`, `observers`, `defaults`, `guardrails`, `toolInterceptors`, `piiPolicies`, `healthChecks`, `tenantContext`, `executionContext`, `executionLimits` (`shutdownTimeout`, `compensationTimeout`, `maxConcurrentSteps`, `childClaimTimeout`), `retention.pauseRecords` / `executionRecords`, `isolatedWorker`, `promptVariables` |
| `@Workflow` (`workflows/<workflow-name>/<workflow-name>.workflow.ts`)                              | —                                                                                                                               | `name` (`-workflow`), `version`, `historyTtl` (required), `flow`, `providers` / `services`, `modelProvider`, `defaults`, `executionLimits` (`maxSteps`, `maxDepth`, `maxConcurrency`, `maxPathDepth`), `placement`, `budget`, `filePolicy`, `guardrails`, `toolInterceptors`, `piiPolicies`, `memory`, `promptVariables`                                                                                                                                                                                                                                                                                   |
| `@WorkflowStart` / `@WorkflowFinish` (`workflows/<workflow-name>/*.workflow-{start,finish}.ts`)    | none: a finish is a pure boundary port (no `deps`, no `input`)                                                                  | `name`, `description`, `input` (start) / `output` (finish: a DTO or `listOf(…)`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@Agent` (`agents/<name>/<name>.agent.ts` + `<name>.prompt.md`)                                    | none: the framework runs its loop                                                                                               | `model`, `modelProvider`, `prompt` (+ `promptVariables`), `input`, `output`, `tools`, `executionLimits` (`maxToolCalls`, `maxVisits`, `maxRetries`, `maxModelCalls`), `maxTokens`, `reasoning`, `temperature`, `cache`, `files`, `rag`, `judges`, `memory`, `guardrails`, `toolInterceptors`, `piiPolicies`                                                                                                                                                                                                                                                                                                |
| `@Tool` (`tools/<name>.tool.ts`, DTOs in `dto/<name>.dto.ts`)                                      | `execute(input)`: the output, or a promise of it                                                                                | `input`, `output`, `timeout: seconds(…)` (default 30 s), `maxResultSize: kilobytes(…)`, `approval` (a `@ToolApproval` target), `readOnly`, `toolInterceptors`, `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@Action` (`actions/<name>.action.ts`)                                                             | `ActionHandler<Self>`: `execute(input)`, sync or async                                                                          | `input` (fields from the scope), `output`, `timeout` (none by default), `compensateWith`, `committedBy`, `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@Router` (`routers/<name>/<name>.router.ts` (+ `<name>.prompt.md`))                               | code: `RouterHandler<Self>`: `route(input)`                                                                                     | `decidedBy`, `input`, `routes`, `maxVisits`; model: `model`, `modelProvider`, `prompt`; code: `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@Arbiter` (`arbiters/<name>/<name>.arbiter.ts` (+ `<name>.prompt.md`))                            | code: `@Arbitrate(…targets)` methods for the targets of the launch                                                              | model: `model`, `modelProvider`, `prompt`, `criteria`; code: `deps` (an `ArbiterModel` for the hard cases)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@Judge` (`judges/<name>/<name>.judge.ts` (+ `<name>.prompt.md`))                                  | `judge(input)`, sync or async                                                                                                   | `name`, `output` (the answer's shape), `prompt`, `threshold`, `model` / `modelProvider` (with `JudgeModel` in `deps`), `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@Rag` (`rag/<name>.rag.ts`, `@agboss/core/rag`)                                                   | `RagSource`: `retrieve(query, { topK, signal, scopeId })`                                                                       | `name` (`-rag`), `description`, `scope`, `topK`, `reranker`, `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@Memory` (`memories/<name>/<name>.memory.ts` (+ `<name>.prompt.md`))                              | none; a code compaction: a `compact(input)` method (no `implements`)                                                            | `name` (`-memory`), `description`, `ttl`, `uncompactedTurns`, `turnsBetweenCompactions`, `compaction: { strategy, prompt, modelProvider, model, summaryQueueLength, summaryMaxTokens }` or `compact()` + `deps`; `NoMemory` is the built-in "no earlier turn"                                                                                                                                                                                                                                                                                                                                              |
| `@InputGuardrail` / `@OutputGuardrail` (`guardrails/<name>/<name>.guardrail.ts`)                   | code: `InputGuardrailHandler` / `OutputGuardrailHandler`                                                                        | `name`, `description`; model: `model`, `modelProvider`, `prompt`, `threshold`, `refusal`; code: `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@ToolApproval` / `@ExternalTask` (`channels/<name>.tool-approval.ts` / `<name>.external-task.ts`) | an empty class; optional hooks `assign`, `resolveTimeout`, `permitAnswer`, `permitTimeoutChange`, `permitReassign`, `onExpired` | `name` (`-tool-approval` / `-external-task`), `description`, `respondent`, `timeout` (required), `input` (+ `output`, `maxVisits` for a task), `remindBefore`, `calendar`, `escalatesTo`, `escalationLimits`, `channelInterpreter`, `deps`                                                                                                                                                                                                                                                                                                                                                                 |
| `@Channel` / `@ChannelSelector` / `@ChannelListener` (`channels/<name>.channel.ts`)                | `send(ask)` (+ the `onPause…` hooks) / `selectChannel(ctx)` / the `onPause…` hooks                                              | `name`, `description`, `target`, `ttl` (a channel); `target` (a selector); `includePauseIds` (a listener); `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@ChannelInterpreter` (`channels/<name>.channel-interpreter.ts`)                                   | code: `ChannelInterpreterHandler<Self>`: `interpret(input)`; model: an empty class                                              | `name?`, `description?`; model: `model`, `modelProvider`, `prompt`, `promptVariables`; code: `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@ModelProvider` (`model-providers/<name>.model-provider.ts`)                                      | an empty class with a `driver`; or a transport: `complete(request)`                                                             | `name?`, `driver` (`OpenRouterDriver`, `OpenAiCompatibleDriver`, `DecisionsDriver`), `timeout` (required), `cost`, `model` / `models`, `retryPolicy`, `rateLimitPolicy`, `circuitBreakerPolicy`, `fallback`, `reasoning`, `promptCaching`                                                                                                                                                                                                                                                                                                                                                                  |
| `@DatabaseStorage` / `@ClusterStorage` / `@ObjectStorage` (`storages/<name>.<kind>-storage.ts`)    | an empty class                                                                                                                  | `name?`, `driver`; a database: `auditLogTtl`, `ledgerEntriesTtl` (required), `idempotencySecret`, `piiSecret`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@Budget` (`budgets/<name>.budget.ts`)                                                             | `BudgetHandler`: `maxSpend()`                                                                                                   | `name` (`-budget`), `scope`, `period`, `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@HealthCheck` (`health-checks/<name>.health-check.ts`)                                            | `check(ctx?: HealthCheckContext)`                                                                                               | `name?`, `timeout?` (5 s), `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@ToolInterceptor` (`tool-interceptors/<name>.tool-interceptor.ts`)                                | `@BeforeTool(Tool)` / `@AfterTool(Tool)` methods, `beforeAnyTool` / `afterAnyTool`                                              | `name?`, `description?`, `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@Injectable` service (`services/<name>.service.ts`)                                               | domain / API / filesystem orchestration (no direct DB/SQL)                                                                      | `deps` (`services/` holds **only** `*.service.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@Injectable` repository (`repositories/<name>.repository.ts`)                                     | direct DB access via typed ORM (e.g. Drizzle) or store impl                                                                     | `deps` (uses `schemas/<name>.schema.ts` & `sql/<name>.sql`, zero string-interpolated SQL)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `@Injectable` observer (`observers/<name>.observer.ts`)                                            | `ExecutionObserver` hooks                                                                                                       | `deps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `AGBossError` subclass (`errors/<name>.error.ts`)                                                  | `static override readonly code = "…"`                                                                                           | caught in flows via `.onError(MyError, …)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

`npx agboss generate` (alias `g`) writes workflows (`w`), agents (`a`), routers (`r`), arbiters (`ar`),
tools (`t`), MCP servers (`m`), knowledge bases (`rag`), OpenAPI clients (`oa`) and eval cases (`ec`);
write the others by hand in the same grammar (`judges/<name>/<name>.judge.ts`,
`health-checks/<name>.health-check.ts`, `memories/<name>/<name>.memory.ts`).

Every component: `name` in kebab-case, unique in the
application (a persisted one — workflow, agent, action, router, budget, … — ends with its kind, `[name.kind-suffix]`; the others default it to the class name in kebab-case and are checked by `[name.not-kebab-case]`) (`[graph.duplicate-node-name]`); `description` where the type asks for it; `deps` that
match the constructor exactly, in order — a wrong list does not compile. `implements` documents the
contract; the check is on the decorator line.

## A worked example: a support desk's components

One class per file in a project, each in the folder of its kind.

```ts file=src/environments/app.environment.ts
// environments/app.environment.ts — the contract: declared fields only, never a value
import type { Secret } from "@agboss/core";

export class AppEnvironment {
   crmUrl!: string;
  crmApiKey?: Secret; // prints as ***; only .reveal() gives the value; optional: tests leave it out
  crmRetries!: number;
}
```

```ts file=src/environments/dev.environment.ts
// environments/dev.environment.ts — one file per environment; `--env dev` (the default) picks it
import { env, secret } from "@agboss/core";
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = {
  crmUrl: env("CRM_URL", { default: "http://localhost:4000" }),
  crmApiKey: secret("CRM_API_KEY"), // no default: a literal secret does not compile
  crmRetries: env.integer("CRM_RETRIES", { default: 2 }), // also env.flag, env.optional, env.integer.optional
};
```

```ts file=src/environments/test.environment.ts
// environments/test.environment.ts — what testWith runs on; without it tests fail to start.
// A secret() whose variable is unset fails the start, so a test environment leaves secrets out.
import type { AppEnvironment } from "./app.environment.js";

export const environment: AppEnvironment = { crmUrl: "http://crm.test", crmRetries: 0 };
```

```ts file=src/desk/dto/customer-query.dto.ts
// dto/<name>.dto.ts — one *Dto class per file
import { Text } from "@agboss/core/dto";

export class CustomerQueryDto {
  @Text({ prompt: "the customer's email" })
  email!: string;
}
```

```ts file=src/desk/dto/customer.dto.ts
import { Bool, Text } from "@agboss/core/dto";

export class CustomerDto {
  @Text({ prompt: "the customer's plan" })
  plan!: string;

  @Bool({ prompt: "whether the customer has an open ticket" })
  hasOpenTicket!: boolean;
}
```

```ts file=src/desk/dto/desk-answer.dto.ts
import { Text } from "@agboss/core/dto";

export class DeskAnswerDto {
  @Text({ prompt: "the answer to send, citing [source]s" })
  text!: string;
}
```

```ts file=src/desk/services/crm-client.service.ts
// services/crm-client.service.ts — a service with lifecycle hooks; config from ApplicationContext
import { ApplicationContext, Injectable, type OnDestroy, type OnStart } from "@agboss/core";

@Injectable({ deps: [ApplicationContext] })
export class CrmClientService implements OnStart, OnDestroy {
  constructor(private readonly applicationContext: ApplicationContext) {}

  async onStart(): Promise<void> {
    await this.ping(); // a failure stops the start, naming this class and the hook
  }

  onDestroy(): Promise<void> {
    return Promise.resolve(); // close pools here: after every execution ended, dependants first
  }

  ping(): Promise<boolean> {
    return Promise.resolve(this.applicationContext.environment.crmUrl.length > 0);
  }

  lookUp(email: string, signal: AbortSignal): Promise<{ plan: string; hasOpenTicket: boolean }> {
    const { crmUrl, crmApiKey } = this.applicationContext.environment; // typed by AppEnvironment
    signal.throwIfAborted();
    const isAuthorised: boolean = crmApiKey !== undefined && crmApiKey.reveal() !== "";
    return Promise.resolve({ plan: `${crmUrl}/${email}`, hasOpenTicket: !isAuthorised });
  }
}
```

```ts file=src/desk/tools/customer-lookup.tool.ts
// tools/customer-lookup.tool.ts — the execution and the spend come through the constructor
import { ExecutionContext, SpendRecorder, Tool } from "@agboss/core";
import { kilobytes, seconds, usd } from "@agboss/core/units";
import { CustomerQueryDto } from "../dto/customer-query.dto.js";
import { CustomerDto } from "../dto/customer.dto.js";
import { CrmClientService } from "../services/crm-client.service.js";

@Tool({
  name: "customer-lookup-tool",
  description: "Looks a customer up in the CRM by email",
  input: CustomerQueryDto,
  output: CustomerDto,
  timeout: seconds(5), // there is no timeoutMs
  maxResultSize: kilobytes(16),
  deps: [ExecutionContext, SpendRecorder, CrmClientService],
})
export class CustomerLookupTool {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
    private readonly crmClientService: CrmClientService,
  ) {}

  async execute({ email }: CustomerQueryDto): Promise<CustomerDto> {
    const customer = await this.crmClientService.lookUp(email, this.executionContext.signal);
    this.spendRecorder.record({ service: "crm-api", cost: usd(0.001) }); // counted in the budgets
    return customer;
  }
}
```

```ts file=src/desk/rag/help-center.rag.ts
// rag/help-center.rag.ts — a knowledge base: a class extending RagSource; every retrieval carries the
// scope's id (a tenant's, an owner's, a custom one's) — return that scope's passages only. `scope` is
// required: `RagScope.Tenant` reads `options.scopeId`; `RagScope.Shared` is one corpus every tenant may
// read and is told no scope, a declared choice (none → `[rag.scope-required]`)
import {
  Rag,
  RagScope,
  RagSource,
  type RagRetrieval,
  type RagRetrieveOptions,
} from "@agboss/core/rag";

const ARTICLES = new Map([["default", [{ text: "Refunds take 5 days.", source: "help/refunds.md" }]]]);

@Rag({
  name: "help-center-rag",
  description: "Help-center articles",
  scope: RagScope.Tenant,
  topK: 3,
})
export class HelpCenterRag extends RagSource {
  protected override retrieve(query: string, options: RagRetrieveOptions): RagRetrieval {
    const results = (ARTICLES.get(options.scopeId ?? "") ?? []).filter(() => query !== "");
    return { results: results.slice(0, options.topK) };
  }
}
```

An agent lists a knowledge base in `rag: [HelpCenterRag]` (its passages come with the input, before the
first model call), or a `@Tool` injects it (`deps: [HelpCenterRag]`) and calls `search(query)` — with the
ready-made `RagQueryDto` / `RagSearchResultsDto` of `@agboss/core/rag`; `@Tool` knows nothing of RAG.
A knowledge base may rerank its candidates before the agent reads them: `@Rag({ topK, reranker })`
names a `@RagReranker` class that carries the `candidates` — the source is asked for `candidates`, the
agent gets the best `topK`. An empty class is the core's LLM reranker on the cascade's model; a class
with a `rerank` method is your own (no `implements`). A failing reranker fails the step unless it says
`onFailure: RerankFailurePolicy.Fallback`:

```ts file=src/desk/rerankers/help-center.reranker.ts
// rerankers/help-center.reranker.ts — by code: a subset of the candidates, best first, at most topK
import {
  RagReranker,
  type RagSearchResultDto,
  type RerankOptions,
  type RerankResult,
} from "@agboss/core/rag";

@RagReranker({
  name: "help-center-reranker",
  description: "Puts articles that name the query first",
  candidates: 20,
})
export class HelpCenterReranker {
  rerank(
    query: string,
    candidates: readonly RagSearchResultDto[],
    { topK }: RerankOptions,
  ): RerankResult {
    const named = candidates.filter((candidate) => candidate.text.includes(query));
    const rest = candidates.filter((candidate) => !candidate.text.includes(query));
    return { results: [...named, ...rest].slice(0, topK) };
  }
}
```

```ts file=src/desk/rerankers/help-model.reranker.ts
// rerankers/help-model.reranker.ts — by model: the core's LLM reranker, no code
import { RagReranker } from "@agboss/core/rag";

@RagReranker({ name: "help-model-reranker", description: "Reranks on a cheap model", candidates: 20, model: "fast" })
export class HelpModelReranker {}
```

```ts file=src/desk/memories/conversation/conversation.memory.ts
// memories/conversation/conversation.memory.ts — how long a thread is kept, what readers see of it, what happens to old turns
import { CompactionStrategy, Memory, inline } from "@agboss/core";
import { days } from "@agboss/core/units";

@Memory({
  name: "conversation-memory",
  description: "Remembers a conversation for 30 days, summarising old turns",
  ttl: days(30), // required: a duration, or Ttl.Forever
  uncompactedTurns: 8, // the last 8 turns in full (TurnLimit.All: every turn); default 5
  turnsBetweenCompactions: 5,
  compaction: {
    strategy: CompactionStrategy.SummaryQueue,
    prompt: inline("Summarise the turns under `Turns to compact`: what was asked, decided and is still open."),
    model: "moonshotai/kimi-k2.6",
    summaryQueueLength: 10,
    summaryMaxTokens: 400,
  },
})
export class ConversationMemory {}
```

A memory whose class has a `compact(input)` method (sync or async, no `implements`) writes the summaries
itself: `previousSummaries` are the readers' summaries now, `turnsToCompact` each a `CompactionTurn`
(`start`, `input`, `finish`, `output`, masked by the PII policies); it returns the summaries readers see
from now on, its services come through `deps`. A decorator `compaction` and a `compact()` method together
do not compile and fail assembly (`[memory.conflicting-compaction]`); neither → the window only. It runs
when a model's would — every `turnsBetweenCompactions` turns older than the window, before the next turn
reads its thread; a `compact()` that throws or gives no summary is `StepError.Memory`. `NoMemory` on an agent
or a router sees no earlier turn; a workflow without `memory` is stateless.

<!-- snippet-context
import { Injectable, type CompactionTurn } from "@agboss/core";
@Injectable()
class KnowledgeGraphService {
  saveFactsAndSummarize(
    _threadId: string,
    turns: readonly CompactionTurn[],
    previous: readonly string[],
  ): Promise<readonly string[]> {
    return Promise.resolve([...previous, `${String(turns.length)} turns saved`]);
  }
}
// @snippet
-->

```ts file=src/desk/memories/graph-memory/graph-memory.memory.ts
// memories/graph-memory/graph-memory.memory.ts — the facts go to a knowledge graph, its summary to readers
import { ExecutionContext, Memory, Ttl, type CompactionInput } from "@agboss/core";

@Memory({
  name: "graph-memory",
  description: "Keeps the facts of old turns in a knowledge graph",
  ttl: Ttl.Forever,
  uncompactedTurns: 3,
  turnsBetweenCompactions: 4,
  deps: [KnowledgeGraphService, ExecutionContext], // KnowledgeGraphService in the workflow's providers
})
export class GraphMemory {
  constructor(
    private readonly knowledgeGraphService: KnowledgeGraphService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async compact(input: CompactionInput): Promise<readonly string[]> {
    return this.knowledgeGraphService.saveFactsAndSummarize(
      this.executionContext.threadId,
      input.turnsToCompact,
      input.previousSummaries,
    );
  }
}
```

A decision model (Jev) is served by a decisions provider — a component naming one says so with `modelProvider`:

```ts file=src/model-providers/decisions.model-provider.ts
import { secret } from "@agboss/core";
import { DecisionsDriver, ModelCost, ModelProvider } from "@agboss/core/models";
import { seconds } from "@agboss/core/units";

@ModelProvider({
  name: "decisions-model-provider",
  description: "Jev and the other decision models, on OpenRouter's Decisions API",
  driver: DecisionsDriver({ baseUrl: "https://openrouter.ai/api/v1", apiKey: secret("OPENROUTER_API_KEY") }),
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
})
export class DecisionsModelProvider {}
```

```ts file=src/desk/judges/cites-source/cites-source.judge.ts
import { DecisionsModelProvider } from "../../../model-providers/decisions.model-provider.js";
// judges/cites-source/cites-source.judge.ts — runs on the agent's answer, as its DTO
import { Decision, Judge, JudgeModel, JudgeVerdict, type JudgeHandler, type JudgeInput } from "@agboss/core";
import { DeskAnswerDto } from "../../dto/desk-answer.dto.js";

@Judge({
  name: "cites-source-judge",
  model: "typesafe/jev-1.13", // a decision model: judgeModel.decide; a chat model: judgeModel.invoke
  modelProvider: DecisionsModelProvider,
  output: DeskAnswerDto, // the agent's output shape: a DTO, oneOf(A, B), listOf(X) or PlainTextDto
  deps: [JudgeModel],
})
export class CitesSourceJudge implements JudgeHandler<DeskAnswerDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output, task }: JudgeInput<DeskAnswerDto>): Promise<JudgeVerdict> {
    const answers = await this.judgeModel.decide({
      state: { task, answer: output.text },
      questions: { cites: Decision.boolean("Does every claim of the answer cite a [source]?") },
    });
    return answers.cites.probability >= 0.5
      ? JudgeVerdict.passed({ metrics: { cites: answers.cites.probability } })
      : JudgeVerdict.failed("cite a [source] for every claim"); // read by the retry
  }
}
```

```ts file=src/desk/agents/support/support.agent.ts
// agents/support/support.agent.ts — every model setting in one place; the prompt in a file next to it
import { Agent, TokenLimit } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { Reasoning, ReasoningEffort } from "@agboss/core/models";
import { ConversationMemory } from "../../memories/conversation/conversation.memory.js";
import { DeskAnswerDto } from "../../dto/desk-answer.dto.js";
import { CitesSourceJudge } from "../../judges/cites-source/cites-source.judge.js";
import { HelpCenterRag } from "../../rag/help-center.rag.js";
import { CustomerLookupTool } from "../../tools/customer-lookup.tool.js";

@Agent({
  name: "support-agent",
  description: "Answers a customer from the CRM and the help center",
  prompt: "./support.prompt.md",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: DeskAnswerDto,
  tools: [CustomerLookupTool],
  executionLimits: { maxToolCalls: 4, maxRetries: 1 },
  rag: [HelpCenterRag], // its passages come with the input
  reasoning: Reasoning.on({ effort: ReasoningEffort.Low }), // not `thinking`
  maxTokens: TokenLimit.ModelMax, // the only way to say "no output cap"
  judges: [CitesSourceJudge],
  memory: ConversationMemory, // its ttl, its window of recent turns and what is older
})
export class SupportAgent {}
```

```md file=src/desk/agents/support/support.prompt.md
You answer customers. Look the customer up with customer-lookup-tool, read the help-center passages that come with the question, and cite every claim as [source].
```

```ts file=src/desk/health-checks/crm.health-check.ts
// health-checks/crm.health-check.ts — a readiness component of the project
import { HealthCheck, HealthCheckResult, type HealthCheckContext } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { CrmClientService } from "../services/crm-client.service.js";

@HealthCheck({ name: "crm-health-check", timeout: seconds(2), deps: [CrmClientService] })
export class CrmHealthCheck {
  constructor(private readonly crmClientService: CrmClientService) {}

  async check(ctx: HealthCheckContext): Promise<HealthCheckResult> {
    // ctx.signal aborts when the check passes its timeout
    const isReachable: boolean = await this.crmClientService.ping();
    return isReachable
      ? HealthCheckResult.healthy()
      : HealthCheckResult.unhealthy("CRM is unreachable");
  }
}
```

```ts file=src/desk/infrastructure/prefixed-id-generator.ts
// infrastructure/prefixed-id-generator.ts — replaced by inheritance: list it in the application
import { IdGenerator, Injectable } from "@agboss/core";

@Injectable()
export class PrefixedIdGenerator extends IdGenerator {
  newThreadId(): string {
    return `thr_${crypto.randomUUID()}`;
  }

  newExecutionId(): string {
    return `exe_${crypto.randomUUID()}`;
  }
}
```

```ts file=src/desk/workflows/desk/desk.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

@WorkflowStart({ name: "desk-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class DeskWorkflowStart {}
```

```ts file=src/desk/workflows/desk/desk.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { DeskAnswerDto } from "../../dto/desk-answer.dto.js";

@WorkflowFinish({ name: "desk-workflow-finish", description: "The answer", output: DeskAnswerDto })
export class DeskWorkflowFinish {}
```

```ts file=src/desk/workflows/desk/desk.workflow.ts
import { Workflow, onStart, toAgent, toFinish, Ttl } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { SupportAgent } from "../../agents/support/support.agent.js";
import { DeskAnswerDto } from "../../dto/desk-answer.dto.js";
import { CrmClientService } from "../../services/crm-client.service.js";
import { DeskWorkflowFinish } from "./desk.workflow-finish.js";
import { DeskWorkflowStart } from "./desk.workflow-start.js";

@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DeskWorkflowStart)
      .toAgent(SupportAgent)
      .toFinish(DeskWorkflowFinish),
  ],
  defaults: { tools: { maxToolCalls: 6 } }, // over the application's, under the agent's own
  executionLimits: { maxSteps: 2 },
  providers: [CrmClientService], // services only — never infrastructure
})
export class DeskWorkflow {}
```

```ts file=src/desk/budgets/application-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(10);
  }
}
```

```ts file=src/desk/budgets/tenant-daily.budget.ts
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(2);
  }
}
```

```ts file=src/desk/budgets/execution.budget.ts
import { Budget, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

@Budget({ name: "execution-budget", scope: BudgetScope.Execution })
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}
```

The chat provider — every application names its `modelProvider` explicitly (a driver provider; no built-ins):

```ts file=src/model-providers/openrouter.model-provider.ts
import { secret } from "@agboss/core";
import { ModelCost, ModelProvider, OpenRouterDriver } from "@agboss/core/models";
import { minutes } from "@agboss/core/units";

@ModelProvider({
  name: "openrouter-model-provider",
  description: "OpenRouter — every chat model of the application",
  driver: OpenRouterDriver({ apiKey: secret("OPENROUTER_API_KEY") }),
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
})
export class OpenRouterModelProvider {}
```

```ts file=src/desk.application.ts
import { OpenRouterModelProvider } from "./model-providers/openrouter.model-provider.js";
import { Application } from "@agboss/core";
import { ApplicationDailyBudget } from "./desk/budgets/application-daily.budget.js";
import { ExecutionBudget } from "./desk/budgets/execution.budget.js";
import { TenantDailyBudget } from "./desk/budgets/tenant-daily.budget.js";
import { CrmHealthCheck } from "./desk/health-checks/crm.health-check.js";
import { PrefixedIdGenerator } from "./desk/infrastructure/prefixed-id-generator.js";
import { DeskWorkflow } from "./desk/workflows/desk/desk.workflow.js";
import { AppEnvironment } from "./environments/app.environment.js";

@Application({
  modelProvider: OpenRouterModelProvider,
  name: "desk-application",
  version: "1.0.0",
  environment: AppEnvironment,
  workflows: [DeskWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  providers: [OpenRouterModelProvider, PrefixedIdGenerator], // infrastructure: stores, Clock, IdGenerator, Logger, channels
  healthChecks: [CrmHealthCheck],
  defaults: {
    models: { temperature: 0 },
    router: { model: "typesafe/jev-1.13" }, // model routers without their own (each names its decisions `modelProvider`)
    guardrail: { model: "typesafe/jev-1.13" }, // guardrails without their own, never the router's (same: a decisions `modelProvider`)
  },
})
export class DeskApplication {}
```

## Dependency injection

- **One container per application instance, one instance per class**, created at start. A class
  listed by two workflows is one instance. There are no request scopes: what differs per execution
  is read from `ExecutionContext`.
- **A token** is a class or an `InjectionToken<T>` (a constant made once at module level, the one
  place a `new` is written); a value goes in with `provide(TOKEN, value)` in `providers`.
  `provide(SomeClass, instance)` is `[di.instance-provider]` — no instances, the container makes them.
- **Replacement by inheritance**: a dependency on a contract (`Clock`, `IdGenerator`, `Logger`, a
  base service) gets the one listed class that `extends` it; two →
  `[di.ambiguous-implementation]`. Stores come from the application's storage drivers and a channel
  is bound to its target (`@Channel({ target })`), neither by inheritance. Infrastructure
  in a workflow's `providers` → `[di.infrastructure-in-workflow]`; a class in `providers` without a
  decorator → `[di.undecorated-provider]`.
- **In tests** a class is replaced by a class, never by an instance:
  `testWith(App, { services: [FakeCrmClientService] })` or the same
  option of a unit runner, where `FakeCrmClientService extends CrmClientService` (reference 10).
- **The four hooks**, each optional, `implements OnInit, OnStart, OnStop, OnDestroy`:
  `onInit()` (dependencies first) → `onStart()` at start (a failure stops the start, naming the
  component and the hook); `app.close()` → `onStop()` (no new executions) → the running executions
  awaited up to `shutdownTimeout` → `onDestroy()` (dependants first; failures collected into one
  error). Open pools and subscriptions in `onStart`, close them in `onDestroy`.
- **No component state**: fields are `private readonly` constructor parameters; `this.cache = …`
  fails lint (`agboss/no-component-state`). A cache or a dedup set is a service over external storage.

## Your own errors

A domain error is an `AGBossError` subclass in `errors/<name>.error.ts`, its name ending with `Error`
and a stable `code` of its own — never a `StepFailedError` (the framework's wrapper of a step's
failure, with the original as its `cause`): `.onError(OrderNotFoundError, …)` after the step that
throws it takes it through that cause.

```ts file=src/desk/errors/order-not-found.error.ts
import { AGBossError } from "@agboss/core";

export class OrderNotFoundError extends AGBossError {
  static override readonly code: string = "orders.not-found";

  constructor(readonly orderId: string) {
    super(`order ${orderId} does not exist`);
  }
}
```

## The frame-bound tokens

Injected like any dependency, read only while a step runs (outside → `ExecutionContextUnavailableError`,
`context.unavailable`):

| Token                                  | Gives                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionContext`                     | `executionId`, `threadId`, `ownerId`, `tenant` (`tenantId`, `weight`, `.application`), `signal` (the execution's, and in a tool call the call's timeout too), `workflow` (`name`, `version`, `configHash`), `step` (`nodeId`, `visitNumber`, `itemIndex`, `copyNumber`, `callId`, `idempotencyKey`), the tree (`parent`, `root`, `depth`, `executionOf(W)`) |
| `SpendRecorder`                        | `record({ service, cost: usd(…) })` — a non-model cost of a tool or action, counted in the budgets (`[spend.outside-step]` outside a step)                                                                                                                                                                                                                  |
| `JudgeModel`                           | a judge's own model: `invoke(text)` on a chat model, `decide({ state, questions })` on a decision model (else `ModelKindError`)                                                                                                                                                                                                                             |
| `ApplicationContext` / `TenantContext` | the levels above: `environment`, `environmentName`, `instanceId`, `startedAt`; the tenant's `tenantId`, `weight` and the project's fields                                                                                                                                                                                                                   |
| `DecisionModel`                        | closed questions to a decision model from a tool or an action: `decide({ state, questions }, { model?, modelProvider? })` — its cost is the step's (budgets, ledger, `decision:<consumer>` in the spend); the provider is the cascade's, so a decisions `modelProvider` is named on the workflow or in the options                                          |

A closed decision from your own code — "is this ticket urgent?" without a router — injects `DecisionModel`
(`deps: [DecisionModel]`), in a `@Tool` or an `@Action` (or a service of theirs):

```ts file=src/desk/dto/ticket.dto.ts
import { Text } from "@agboss/core/dto";

export class TicketDto {
  @Text({ prompt: "the ticket's id" })
  id!: string;

  @Text({ prompt: "what the customer wrote" })
  text!: string;
}
```

```ts file=src/desk/dto/triage.dto.ts
import { Bool, Text } from "@agboss/core/dto";

export class TriageDto {
  @Bool({ prompt: "whether the ticket is urgent" })
  isUrgent!: boolean;

  @Text({ prompt: "the ticket's id" })
  ticketId!: string;
}
```

```ts file=src/desk/actions/triage-ticket.action.ts
import { Action, Decision, DecisionModel } from "@agboss/core";
import { DecisionsModelProvider } from "../../model-providers/decisions.model-provider.js";
import { TicketDto } from "../dto/ticket.dto.js";
import { TriageDto } from "../dto/triage.dto.js";

@Action({
  name: "triage-ticket-action",
  description: "Decides whether a ticket is urgent",
  input: { ticket: TicketDto },
  output: TriageDto,
  deps: [DecisionModel],
})
export class TriageTicketAction {
  constructor(private readonly decisionModel: DecisionModel) {}

  async execute({ ticket }: { readonly ticket: TicketDto }): Promise<TriageDto> {
    const answers = await this.decisionModel.decide(
      {
        state: { text: ticket.text },
        questions: { urgent: Decision.boolean("Does the ticket describe an outage?") },
      },
      { modelProvider: DecisionsModelProvider }, // a decisions provider: the application's is the chat one
    );
    return { isUrgent: answers.urgent.probability >= 0.5, ticketId: ticket.id };
  }
}
```

- **`step.idempotencyKey`** = `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`
  — the same when a step runs again after a crash. Pass it to every external side effect.
- **The tree**: `executionContext.root.executionId` is the root execution's id,
  `executionContext.parent?.executionId` the parent's (a child workflow), `depth` is 1 at the root.
- **Your own context fields**: subclass `TenantContext` / `ExecutionContext` with DTO field
  decorators, declare them once in `@Application({ tenantContext, executionContext })` and inject the
  subclass; the values come per call (`tenant: { tenantId, plan }`, `execution: { userId }`).
  Identity only — never a secret.

## Judges in short

- `@Judge({ output })` must match the agent's `output` (`[judge.wrong-output]` otherwise): a DTO,
  `oneOf(A, B)`, `listOf(X)`, `listOf(A, B)`, or `PlainTextDto` for a text agent.
- `JudgeInput<Self>` (or `JudgeInput<PlainTextDto>`, the output directly) is `{ variant, output, task, attempt }`; for a `oneOf` output narrow with
  `input.output instanceof OfferDto` (`input.variant` is the class the answer validated as); a
  `listOf(A, B)` output's items are instances of their classes (`item instanceof A`).
- A judge that only asks its model is an empty class: `@Judge({ output, prompt: "./criterion.prompt.md" | inline(…), threshold?, model?, modelProvider? })`
  (`threshold` in `(0, 1]`: the model scores, the answer passes at `score >= threshold`; else pass or fail). No `judge()`, no `deps`; the
  budgets are checked before each of its model calls; in tests an unscripted one passes. `[judge.zero-retries]` warns for an agent with judges and no `maxRetries`.
- Verdicts only through `JudgeVerdict.passed({ metrics? })` / `JudgeVerdict.failed(reason)`; when
  `maxRetries` are spent the step fails with `QualityGateError` (`rejections: [{ judge, reason }]`).

<!-- snippet-context
import { Judge, JudgeModel, JudgeVerdict, oneOf, type JudgeHandler, type JudgeInput } from "@agboss/core";
import { Integer, Text } from "@agboss/core/dto";
class OfferDto {
  @Integer({ prompt: "the salary offered" })
  salary!: number;
}
class RefusalDto {
  @Text({ prompt: "why no offer is made" })
  reason!: string;
}
-->

```ts file=src/desk/judges/offer-range/offer-range.judge.ts
@Judge({ name: "offer-range-judge", model: "moonshotai/kimi-k2.6", output: oneOf(OfferDto, RefusalDto), deps: [JudgeModel] })
export class OfferRangeJudge implements JudgeHandler<OfferDto | RefusalDto> {
  judge(input: JudgeInput<OfferDto | RefusalDto>): Promise<JudgeVerdict> {
    if (!(input.output instanceof OfferDto)) return Promise.resolve(JudgeVerdict.passed());
    return Promise.resolve(
      input.output.salary > 0 // narrowed: input.output is an OfferDto here
        ? JudgeVerdict.passed()
        : JudgeVerdict.failed("the salary must be positive"),
    );
  }
}
```

## Arbiters in short

An arbiter decides whether one branch's answer of a parallel launch counts toward a quorum
(`.arbitratedBy(X)`, reference 02). By code: `@Arbitrate(A, B)` methods covering every target of the
launch once, typed by those targets' output (`[arbiter.unhandled-target]`, `[arbiter.unknown-target]`,
`[arbiter.duplicate-target]`); with `deps: [ArbiterModel]` the code also asks its own model; by model:
`model`, `prompt` and one `criteria` entry per target.

```ts file=src/desk/arbiters/has-answer/has-answer.arbiter.ts
import { Arbiter, Arbitrate } from "@agboss/core";
import { SupportAgent } from "../../agents/support/support.agent.js";
import { DeskAnswerDto } from "../../dto/desk-answer.dto.js";

@Arbiter({ name: "has-answer-arbiter" })
export class HasAnswerArbiter {
  @Arbitrate(SupportAgent)
  fromSupport(answer: DeskAnswerDto): boolean {
    return answer.text.trim().length > 0;
  }
}
```

## Tool interceptors

A `@ToolInterceptor` (#384) wraps an agent's calls to its `@Tool`s — a tenant's
scope, an audit, a rewrite of a result. Its class has `@BeforeTool(Tool)` / `@AfterTool(Tool)`
methods (one tool or several: `@BeforeTool(A, B)`), plain `beforeAnyTool(call)` / `afterAnyTool(call)`
for every tool, or both kinds (none: `[tool-interceptor.missing-handler]`; a target that is no tool
`[tool-interceptor.target-not-a-tool]`; two methods for one tool and phase
`[tool-interceptor.duplicate-hook]`; a misspelt name such as `beforeToolCall`
`[tool-interceptor.unknown-hook]`); the name is optional (kebab-case, the class name by default). It is listed in `toolInterceptors: [...]` of `@Application` → `@Workflow` →
`@Agent` → `@Tool` — lists add up, outer first; `excludeToolInterceptors` on an agent
or a tool removes an inherited one (`[tool-interceptor.exclude-not-inherited]`; a class that is not
one is `[tool-interceptor.not-an-interceptor]`).

<!-- snippet-context
import { TenantContext } from "@agboss/core";
import { List, Text } from "@agboss/core/dto";
class JobScoutTenantContext extends TenantContext {
  @List(Text)
  allowedCities!: string[];
}
-->

```ts file=src/desk/tool-interceptors/tenant-scope.tool-interceptor.ts
import { ToolCallDecision, ToolInterceptor, type ToolCallContext } from "@agboss/core";

@ToolInterceptor({
  name: "tenant-scope-tool-interceptor",
  description: "Checks that tool arguments respect the tenant's allowed cities",
  deps: [JobScoutTenantContext],
})
export class TenantScopeToolInterceptor {
  constructor(private readonly jobScoutTenantContext: JobScoutTenantContext) {}

  beforeAnyTool(call: ToolCallContext): ToolCallDecision {
    if (
      typeof call.input === "object" &&
      call.input !== null &&
      "city" in call.input &&
      typeof call.input.city === "string" &&
      !this.jobScoutTenantContext.allowedCities.includes(call.input.city)
    ) {
      return ToolCallDecision.reply(`City "${call.input.city}" is not allowed for this tenant.`);
    }
    return ToolCallDecision.allow();
  }
}
```

```ts file=src/desk/tool-interceptors/audit.tool-interceptor.ts
import { ToolInterceptor, type ToolCallResultContext } from "@agboss/core";

@ToolInterceptor({ name: "audit-tool-interceptor", description: "Logs every tool result" })
export class AuditToolInterceptor {
  afterAnyTool(call: ToolCallResultContext): unknown {
    console.info(`${call.tool.name} answered`); // a real one writes to its audit service
    return call.output; // the result the model reads: the tool's, or a replacement
  }
}

// @Application({ …, toolInterceptors: [AuditToolInterceptor] }) — every agent's tool calls;
// @Workflow({ …, toolInterceptors: [TenantScopeToolInterceptor] }) — its agents' calls
```

- **The before hooks decide**, outer interceptor first, `beforeAnyTool` before the tool's
  `@BeforeTool` method (which takes the validated input DTO; invalid arguments skip it and the tool
  answers its own error): `ToolCallDecision.allow()` — the next one decides, then the tool runs;
  `ToolCallDecision.allow({ input })` — the same, with those arguments (validated against the tool's
  input DTO again) for the next hooks and the tool; `ToolCallDecision.reply(message)` — the tool is
  not called, the model reads `message` as the call's result and may try again (the step goes on);
  `ToolCallDecision.block(reason)` — the tool is not called and the agent's step fails with
  `ToolBlockedError` (`step.tool-blocked`, a `StepFailedError`: `agent`, `tool`, `interceptor`,
  `reason`; `.onError(ToolBlockedError, …)` after the agent takes it).
- **The after hooks replace the result**, inner interceptor first, the tool's `@AfterTool` method (output, input) before `afterAnyTool`, on a successful call only (a tool error goes
  to the model as it is); each output is validated against the tool's output DTO.
- **The order**: the arguments checked against the tool's input → PII block rules on the arguments → the before hooks (`beforeAnyTool` gets the arguments with PII tokens
  revealed; `ToolCall.typeOf(call)` is the tool class) → the approval, if the tool has one (the approver sees the arguments masked and as the hooks left them; a call that did not pass never waits for it, and a resume runs nothing above again) → the tool → the after hooks → `maxResultSize` → PII masking. A
  `reply` message is bounded and masked the same way.
- **In the call's frame**: an injected `ExecutionContext` reads the tool call
  (`step.callId`, `step.idempotencyKey` with the call id, the call's `signal`).
- An interceptor that throws, returns no `ToolCallDecision` or an output its tool does not give
  fails the step — `AgentFailedError`, its error as the `cause` (`.onError(DomainError, …)` takes it
  through the cause).
- Only the project's own `@Tool` calls are intercepted — never an answer tool, a
  knowledge base's search tool or a tool called on its own (over MCP).
- `agboss describe` prints `tool interceptors` (each one's methods and the agents' tools it
  intercepts), `describe --json` each agent's `toolInterceptors` by tool; `configHash` covers them.
  Tests: `testUnit` (reference 10).

## Settings and their units

- **Defaults cascade** `@Application({ defaults })` → `@Workflow({ defaults })` → the component's own
  field, field by field — the most specific set value wins: `defaults.models` (`temperature`,
  `maxTokens`, `reasoning`, `cache`), `defaults.router.model`, `defaults.guardrail.model`,
  `defaults.tools` (`maxToolCalls`, `maxResultSize`). `npx agboss describe` prints where each value came from.
- **Reasoning** is `Reasoning.modelDecides()`, `Reasoning.on({ effort: ReasoningEffort.High })`,
  `Reasoning.on({ budget: { tokens: 2000 } })` or `Reasoning.off()` (`@agboss/core/models`); there is no
  `thinking` option.
- **Units** (`@agboss/core/units`): `seconds()`, `minutes()`, `hours()` for every timeout, deadline and
  retention; `usd()` for money (`Usd`); `kilobytes()` for sizes. A bare number does not compile.
- **Prompts**: a `prompt` is a `PromptSource` (the type of every prompt option: agent, router, arbiter, judge, guardrail, memory compaction, channel interpreter): a file path (`"./support.prompt.md"`, `../`, `/`), `inline("…")` / `` inline`…` `` (the tagged form drops the common indentation) or a list of them, read in order and joined with one blank line, `{{variables}}` from
  `promptVariables` (texts or `defineEnv` references; `@Application` → `@Workflow` → the component, nearest wins) checked at assembly (`[prompt.unknown-variable]`). What a node reads arrives in its
  input message (`### message (from desk-workflow-start)`) — never write `{{input.…}}` in a prompt
  (`[prompt.input-in-instructions]`).
- **Memory**: a `@Memory` class named by `memory` on `@Workflow`, `@Agent` or `@Router` — its `ttl`, its
  `uncompactedTurns` (the thread's last turns each agent and model router sees in full; default 5,
  `TurnLimit.All` = all) and what is older: a `compaction` (`CompactionStrategy.SummaryQueue` /
  `SingleSummary`) or your class's `compact()` (`agboss describe`: `strategy: custom
(GraphMemory.compact())`). The lowest level wins; a code router has none (it does not compile); a
  workflow without `memory` is stateless; `NoMemory` opts an agent out.

## Running the application

<!-- snippet-context
import { createApp, StreamEventKind } from "@agboss/core";
import { DeskApplication } from "./src/desk.application.js";
import { DeskWorkflowStart } from "./src/desk/workflows/desk/desk.workflow-start.js";
-->

```ts
const app = await createApp(DeskApplication, { env: "prod" }); // closes itself on SIGTERM / SIGINT

const controller = new AbortController(); // a caller's cancel, e.g. the client disconnected
const shown = new Map<string, string>(); // the text of each step of the run, as the user sees it
const first = await app.execute(
  DeskWorkflowStart,
  { text: "Where is my refund?" }, // typed by the start's input DTO
  {
    tenant: { tenantId: "acme" },
    threadId: "ticket-4821", // the caller's own id: the next turn of the same conversation
    ownerId: "customer-17", // another owner on this thread → ExecutionError.ThreadOwnerMismatch
    signal: controller.signal,
    onStream: (event) => {
      if (event.kind === StreamEventKind.ToolCall) return; // the name only: a "working…" hint
      const { agent, visit, branch, attempt } = event.step;
      const key = `${branch}/${agent}#${visit}/${attempt}`; // streamed text is provisional, per step
      if (event.kind === StreamEventKind.TextDelta)
        shown.set(key, (shown.get(key) ?? "") + event.delta);
      else shown.delete(key); // Discarded: a judge rejected it, a tool turn, a retry, a failure
    },
  },
);
console.log(first.executionId, first.threadId, first.output?.text, first.spend.totalUsd);

// a second turn: same threadId → the agent sees the earlier turns (the memory's window and compaction)
await app.execute(DeskWorkflowStart, { text: "And the second order?" }, {
  tenant: { tenantId: "acme" },
  threadId: first.threadId,
  ownerId: "customer-17",
});

await app.cancel("ticket-4821", { tenantId: "acme", ownerId: "customer-17" }); // by thread
const readiness = await app.checkReadiness(); // HealthReport: stores, providers, crm-health-check
console.log(readiness.status);
await app.close(); // onStop → running executions awaited → onDestroy
```

- **What `onStream` carries**: only the agent's own answering call streams (routers, judges,
  guardrails, PII detection and the like are silent). Events (`StreamEventKind`, #1311):
  `{ kind: StreamEventKind.TextDelta, delta, step }`,
  `{ kind: StreamEventKind.Discarded, step, reason }` (a `StreamDiscardReason`:
  `JudgeRejected` = `"judge-rejected"`, `ToolTurn`, `InvalidAnswer`, `StreamBroken`, `Failed`) and
  `{ kind: StreamEventKind.ToolCall, tool, step }` (the name only; `step` is the model call that asked for it). **Streamed text is provisional**:
  `step` is `{ agent, visit, branch, attempt }`; a `StreamEventKind.Discarded` event retracts
  everything streamed for that step, and the deltas of the steps never discarded, joined, are
  `output` — so keep a buffer per step key and drop it on `StreamEventKind.Discarded` (or print
  `result.output` at the end). Under a **blocking output check** (an output guardrail, a PII policy
  with a block rule) the text is held until the checks passed: a refused answer never reaches the
  stream. With PII policies a token the model wrote (`<email:9cf08e>`) is revealed as the run's
  value; leading whitespace is not streamed and trailing whitespace waits for the text after it. A listener that
  throws never fails the run: it is logged once per run (`stream.listener-failed`).
- **`executionId` vs `threadId`**: an execution is one pass of `app.execute` (or a resume); a thread
  is the conversation of many executions, keyed by `tenantId` + `threadId`. Without a `threadId` a
  new thread is made (its id in the result); an id the tenant does not have yet creates it.
- **Cancel** by `app.cancel(threadId, { tenantId, ownerId })` (a running execution resolves
  `ExecutionStatus.Cancelled` — inside a step the abort surfaces as `ExecutionCancelledError`, which
  no caller of `execute` / `resume` sees —, a paused one is dropped) or by the `signal` you passed.
- After `app.close()` every `execute` / `resume` rejects with `ApplicationStoppingError`.

## Undoable actions: `compensateWith`, `committedBy`

An action with a side effect the flow may have to take back names its undo — another `@Action`, code,
never a model call — and optionally the action after which nothing undoes it any more. Where the flow
goes after a failure is reference 02, section 8; the tests reference 10.

The booking's DTOs, its start and its finish:

```ts file=src/booking/dto/seat-request.dto.ts
import { Text } from "@agboss/core/dto";

export class SeatRequestDto {
  @Text({ prompt: "the flight and the passenger" })
  request!: string;
}
```

```ts file=src/booking/dto/seat-hold.dto.ts
import { Text } from "@agboss/core/dto";

export class SeatHoldDto {
  @Text({ prompt: "the hold's id" })
  holdId!: string;
}
```

```ts file=src/booking/dto/ticket-issued.dto.ts
import { Text } from "@agboss/core/dto";

export class TicketIssuedDto {
  @Text({ prompt: "the ticket number" })
  ticketNumber!: string;
}
```

```ts file=src/booking/workflows/seat/seat.workflow-start.ts
import { WorkflowStart } from "@agboss/core";
import { SeatRequestDto } from "../../dto/seat-request.dto.js";

@WorkflowStart({ name: "seat-workflow-start", description: "A seat to book", input: SeatRequestDto })
export class SeatWorkflowStart {}
```

```ts file=src/booking/workflows/seat/ticket-issued.workflow-finish.ts
import { WorkflowFinish } from "@agboss/core";
import { TicketIssuedDto } from "../../dto/ticket-issued.dto.js";

@WorkflowFinish({ name: "ticket-issued-workflow-finish", description: "The ticket", output: TicketIssuedDto })
export class TicketIssuedWorkflowFinish {}
```

```ts file=src/booking/services/airline.service.ts
import { Injectable } from "@agboss/core";

@Injectable()
export class AirlineService {
  hold(request: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`${request}:${idempotencyKey}`);
  }

  release(holdId: string, idempotencyKey: string): Promise<void> {
    void holdId;
    void idempotencyKey; // an undo runs again after a crash: make it safe twice by this key
    return Promise.resolve();
  }
}
```

```ts file=src/booking/actions/release-seat.action.ts
// the undo: reads only what the path holds right after the action it undoes
import { Action, ExecutionContext, type ActionHandler, type InputOf } from "@agboss/core";
import { SeatHoldDto } from "../dto/seat-hold.dto.js";
import { AirlineService } from "../services/airline.service.js";

@Action({
  name: "release-seat-action",
  description: "Releases a held seat",
  input: { hold: SeatHoldDto },
  deps: [AirlineService, ExecutionContext],
})
export class ReleaseSeatAction implements ActionHandler<ReleaseSeatAction> {
  constructor(
    private readonly airlineService: AirlineService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<ReleaseSeatAction>): Promise<void> {
    // on a side path its own step's key; automatic: the undone step's key + ":compensation"
    await this.airlineService.release(input.hold.holdId, this.executionContext.step.idempotencyKey);
  }
}
```

```ts file=src/booking/actions/issue-ticket.action.ts
// the commit point: once it succeeds, nothing undoes the hold
import { Action, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { SeatHoldDto } from "../dto/seat-hold.dto.js";
import { TicketIssuedDto } from "../dto/ticket-issued.dto.js";

@Action({ name: "issue-ticket-action", description: "Issues the ticket", input: { hold: SeatHoldDto }, output: TicketIssuedDto })
export class IssueTicketAction implements ActionHandler<IssueTicketAction> {
  execute(input: InputOf<IssueTicketAction>): Promise<OutputOf<IssueTicketAction>> {
    return Promise.resolve({ ticketNumber: `T-${input.hold.holdId}` });
  }
}
```

```ts file=src/booking/actions/hold-seat.action.ts
import { Action, ExecutionContext, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { SeatHoldDto } from "../dto/seat-hold.dto.js";
import { SeatRequestDto } from "../dto/seat-request.dto.js";
import { AirlineService } from "../services/airline.service.js";
import { IssueTicketAction } from "./issue-ticket.action.js";
import { ReleaseSeatAction } from "./release-seat.action.js";

@Action({
  name: "hold-seat-action",
  description: "Holds a seat",
  input: { request: SeatRequestDto },
  output: SeatHoldDto,
  compensateWith: ReleaseSeatAction, // an @Action: [action.compensator-not-an-action] otherwise
  committedBy: IssueTicketAction, // without it, a finish commits the hold
  deps: [AirlineService, ExecutionContext],
})
export class HoldSeatAction implements ActionHandler<HoldSeatAction> {
  constructor(
    private readonly airlineService: AirlineService,
    private readonly executionContext: ExecutionContext,
  ) {}

  async execute(input: InputOf<HoldSeatAction>): Promise<OutputOf<HoldSeatAction>> {
    const key: string = this.executionContext.step.idempotencyKey;
    return { holdId: await this.airlineService.hold(input.request.request, key) };
  }
}
```

```ts file=src/booking/workflows/seat/seat.workflow.ts
import { Workflow, onStart, toAction, toFinish, Ttl } from "@agboss/core";
import { HoldSeatAction } from "../../actions/hold-seat.action.js";
import { IssueTicketAction } from "../../actions/issue-ticket.action.js";
import { SeatHoldDto } from "../../dto/seat-hold.dto.js";
import { SeatRequestDto } from "../../dto/seat-request.dto.js";
import { TicketIssuedDto } from "../../dto/ticket-issued.dto.js";
import { AirlineService } from "../../services/airline.service.js";
import { SeatWorkflowStart } from "./seat.workflow-start.js";
import { TicketIssuedWorkflowFinish } from "./ticket-issued.workflow-finish.js";

@Workflow({
  name: "seat-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(SeatWorkflowStart)
      .toAction(HoldSeatAction)
      .toAction(IssueTicketAction) // commits the hold: no side path after it owes the release
      .toFinish(TicketIssuedWorkflowFinish),
  ],
  providers: [AirlineService],
})
export class SeatWorkflow {}
```

- **The automatic undo** (a failed join's finished branches; an execution that ends without a
  finish — an uncaught failure or limit, a cancel) runs each undo in its own frame: its
  `executionContext.signal` is a clean-up signal, aborted after
  `@Application({ executionLimits: { compensationTimeout } })` (default `seconds(15)`), when the lease is lost or the
  instance stops; no budget refuses it; what its services cost (`SpendRecorder`) is spend under
  `action:<undo name>`. An undo that fails does not stop the others; then the execution fails with
  `ExecutionError.CompensationFailed` (`compensation.failed`: `failures`, `cause`).
- **Observers** see the automatic ones through `onCompensationStart` / `onCompensationEnd`
  (`CompensationStartEvent`: `step`, `compensated`, `reason`; `CompensationEndEvent` adds `status`,
  `error`), around the undo action's own `onActionStart` / `onActionEnd`; `onExecutionError`'s
  `compensations` lists what ran (reference 08). Every run's `result.compensations` lists them all.
- An undo action declares no `compensateWith` of its own (`[action.compensator-compensates]`), never
  undoes itself (`[action.self-compensation]`), and `committedBy` without `compensateWith` is
  `[action.committer-without-compensator]`.

## Rule codes you will meet here

| Code                                       | Cause → fix                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `[name.kind-suffix]`                       | `name: "support"` → `name: "support-agent"` (agents, routers, actions, workflows and budgets end with their kind)                   |
| `[name.not-kebab-case]`                    | a non-persisted component's `name` is not kebab-case → `name: "crm-check"`, or leave it out for the class name in kebab-case        |
| `[di.instance-provider]`                   | `provide(CrmClientService, new CrmClientService(…))` → list the class; values only for tokens                                       |
| `[di.infrastructure-in-workflow]`          | a store, `Clock`, `IdGenerator`, channel or model provider in `@Workflow({ providers })` → move it to `@Application({ providers })` |
| `[di.ambiguous-implementation]`            | two listed classes `extends` one contract → keep one                                                                                |
| `[environment.contract-value]`             | a default value in the contract class → move it to `<name>.environment.ts`                                                          |
| `[environment.missing-field]`              | a listed class (or one its `deps` reach) reads an environment field the contract lacks → declare it                                 |
| `[prompt.input-in-instructions]`           | `{{input.message}}` in a prompt → delete it: the input message carries the field                                                    |
| `[prompt.secret-in-instructions]`          | a `secret(…)` in any `promptVariables` → a text or an `env(…)`: a secret never reaches a model                                      |
| `[prompt.unused-variable]`                 | a component's `promptVariables.tone` no `{{tone}}` uses → delete it                                                                 |
| `[prompt.unknown-variable]`                | `{{tone}}` without `promptVariables: { tone }` → add it                                                                             |
| `[judge.wrong-output]`                     | the judge's `output` is not the agent's `output` shape → make them the same                                                         |
| `[memory.uncompacted-turns-invalid]`       | `uncompactedTurns: -1` or a fraction → a whole number from 0, or `TurnLimit.All`                                                    |
| `[memory.conflicting-compaction]`          | a `@Memory` with `compaction` in its decorator and a `compact(input)` method → choose one                                           |
| `[health.not-a-health-check]`              | a class in `healthChecks` without `@HealthCheck` → decorate it                                                                      |
| `[context.not-declared]`                   | a `TenantContext` subclass injected but not declared → `@Application({ tenantContext })`                                            |
| `[tool-interceptor.missing-handler]`       | a `@ToolInterceptor` class with no `@BeforeTool` / `@AfterTool` / `beforeAnyTool` / `afterAnyTool`                                  |
| `[tool-interceptor.exclude-not-inherited]` | `excludeToolInterceptors` names one no level above lists → drop it                                                                  |
| `[action.invalid-compensator-input]`       | the undo reads a field not on the path right after its action → read what the action returned (`SeatHoldDto`)                       |

## Pitfalls

- `new SomeService()` / `new SomeTool()` anywhere in project code — list classes, inject them.
- `process.env.X` in a component — read `applicationContext.environment.x` (typed, per environment).
- A `ctx` parameter on `execute` — there is none; inject `ExecutionContext`.
- `Date.now()` / `setTimeout` — inject `Clock` (`clock.now()`, `clock.sleep(seconds(1), signal)`).
- Ignoring `executionContext.signal` in a slow call: pass it to `fetch` and SDK clients so a cancel,
  a timeout or a lost lease stops the call.
- An `onStart` that waits for a slow service with no timeout blocks the start — bound it.
