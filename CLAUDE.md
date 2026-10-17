# CLAUDE.md

Multi-agent project on LangGraph + LangChain (TypeScript). Built with a three-phase pipeline:
**triage → spec → implement**. Code is the only source of truth; tickets hold the reasoning.

## Stack

- Node 22+, TypeScript (strict, fully typed — see `QUALITY.md` → Types), ESM
- `@langchain/langgraph` (graph, and each agent's own loop as a subgraph), `@langchain/core`
  (messages, prompts, tools, test fakes), `zod` (inside the framework only — workflows use DTO
  classes, `agboss/dto`)
- LLM access: **OpenRouter** only. Env: `OPENROUTER_API_KEY` (+ optional `OPENROUTER_BASE_URL`).
  - Routers: each `@Router` names its own `model` — a **decision model** (`DECISION_MODELS`: Jev,
    `openai/gpt-6-luna-decisions`, pplx-decider, Clef, …; OpenRouter Decisions API via
    `DecisionsModelProvider` — probabilities, exact cost) or any chat model. Guards use
    `defaults.router` (Jev). Judges on a decision model call `judgeModel.decide` with
    `Decision.noul` / `Decision.choice` / `Decision.score` / `Decision.image` (typed answers);
    `invoke` or `decide` on the wrong kind of model → `ModelKindError`.
  - Agents: cheap chat models (default `moonshotai/kimi-k2.6`) via `@langchain/openai`, each with
    `maxTokens` (`MODEL_MAX` = model's maximum), `thinking`, `cache`.
  - Everything is set in the workflow's components (`@Workflow` with its `flow` of paths and
    `settings()`, `@Router`, `@Agent`) — reference: Architecture below (compiled by `make check`), then Wiki →
    Workflow, Routers, Components, Configuration (compiled by CI, see Quality gates).
- Observability: Langfuse tracing via env (`LANGFUSE_*` keys, loaded only when set). FinOps: built-in cost
  accounting; `@Workflow({ maxSteps })` and each node's `maxVisits`, money in the workflow's
  `settings().limits(...)` — per run (cost) and per day (cost, resets 00:00 UTC); hitting any limit
  fails the run unless an `.onError(…)` takes it (`QUALITY.md` → FinOps).
- Vitest (+ v8 coverage), ESLint (`typescript-eslint` strict), Prettier,
  `@langchain/langgraph-cli` for LangGraph Studio

## Commands

| Command (repo root)                    | What it does                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `make setup`                           | install dependencies (npm workspaces)                                                    |
| `make check`                           | **the gate**: build + API reports + compiled docs + format + lint + typecheck + coverage |
| `npm run dev`                          | rebuild the framework on change (watch)                                                  |
| `npm run check:docs`                   | typecheck the docs' ts blocks, check the commands they mention                           |
| `make smoke`                           | real-model smoke tests of the framework (needs `.env`), never in CI                      |
| `make fmt`                             | auto-format                                                                              |
| `npm run studio`                       | LangGraph Studio (graphs from `langgraph.json`)                                          |
| `scripts/langfuse.sh up\|down\|status` | local Langfuse for tracing; writes keys to `.env`                                        |

In `examples/job-scout/` (each is `agboss <command> --workflow src/job-scout.workflow.ts`):
`npm run chat` · `npm run run -- "task"` · `npm run describe` · `npm run eval` / `replay` ·
`npm run golden -- add --name <n>` · `npm run compare -- --profiles base,<p> --golden <n>` ·
`npm run rag:index` · `npm run probe -- --place <p> <token…>` (Greenhouse boards). Any run command
takes `--profile <name>` (`profiles/<workflow>/<name>.yaml`) and `--thread <id>`.

In `examples/flow-patterns/` (#295; scripted tests only, no model key): `npm run check` (`agboss
check` on both workflows) · `npm run describe -- --workflow src/offer/offer.workflow.ts` (the
review loop) or `src/credit/credit.workflow.ts` (a code router) · `npm test`.

## Architecture

Everything below is checked against the code: every ` ```ts ` block of this file compiles against
the built package (`npm run check:docs`, with the generated `.agboss/types.d.ts` of its workflows),
and the worked example is assembled and run by script in the framework's tests
(`tests/docs/claude-md.test.ts`). If a block here is wrong, `make check` fails.

### A workflow, end to end

A workflow is a folder of components, one class per file, wired by a `*.workflow.ts` module whose
`flow` is a list of **paths** (#272, Wiki → ADR-0019-Flow-as-paths-with-path-scope). Commands find
it by path (`agboss chat --workflow src/desk/desk.workflow.ts`); `agboss check` writes
`.agboss/types.d.ts`, which types the paths, every node's input and `app.execute`. The shape every
workflow follows — a support desk with one tool, one injected service, one agent and a router:

```ts file=src/desk/tools/order-status.dto.ts
// tools/order-status.dto.ts — data crossing a tool boundary are DTO classes, one decorator per field
import { Text } from "agboss/dto";

export class OrderQuery {
  @Text({ prompt: "the order id" })
  orderId!: string;
}

export class OrderInfo {
  @Text({ prompt: "where the order is" })
  status!: string;
}
```

```ts file=src/desk/services/order-book.service.ts
// services/order-book.service.ts — a service: does the I/O, created by the container
import { Injectable } from "agboss";

@Injectable()
export class OrderBook {
  statusOf(orderId: string): Promise<string> {
    return Promise.resolve(`order ${orderId} shipped`);
  }
}
```

```ts file=src/desk/tools/order-status.tool.ts
// tools/order-status.tool.ts — `deps` lists the constructor's dependencies, in order (compiler-checked)
import { ExecutionContext, Tool, type ToolHandler } from "agboss";
import { OrderBook } from "../services/order-book.service.js";
import { OrderInfo, OrderQuery } from "./order-status.dto.js";

@Tool({
  name: "order_status",
  description: "The status of an order",
  input: OrderQuery,
  output: OrderInfo,
  deps: [ExecutionContext, OrderBook],
})
export class OrderStatus implements ToolHandler<OrderQuery, OrderInfo> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly orderBook: OrderBook,
  ) {}

  async run({ orderId }: OrderQuery): Promise<OrderInfo> {
    this.executionContext.signal.throwIfAborted(); // the execution: executionId, threadId, step, …
    return { status: await this.orderBook.statusOf(orderId) };
  }
}
```

```ts file=src/desk/agents/support.agent.ts
// agents/support.agent.ts — the agent's own loop: its model, prompt and tools. No input/output:
// a text agent — it reads the message (WorkflowStartTextDto) and answers text
import { Agent } from "agboss";
import { OrderStatus } from "../tools/order-status.tool.js";

@Agent({
  name: "support-agent",
  description: "Answers questions about orders",
  promptUrls: ["./support.prompt.md"],
  model: "moonshotai/kimi-k2.6",
  tools: [OrderStatus],
})
export class SupportAgent {}
```

```md file=src/desk/agents/support.prompt.md
You answer questions about orders. Look every order up with order_status; never guess a status.
```

```ts file=src/desk/workflow-starts/chat.workflow-start.ts
// workflow-starts/chat.workflow-start.ts — where a run starts: its input DTO
import { WorkflowStart } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";

@WorkflowStart({
  name: "chat-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class ChatWorkflowStart {}
```

```ts file=src/desk/workflow-finishes/chat.workflow-finish.ts
// workflow-finishes/chat.workflow-finish.ts — where a run finishes: its output DTO
import { WorkflowFinish } from "agboss";
import { WorkflowFinishTextDto } from "agboss/dto";

@WorkflowFinish({
  name: "chat-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class ChatWorkflowFinish {}
```

```ts file=src/desk/workflow-finishes/hand-over.workflow-finish.ts
// workflow-finishes/hand-over.workflow-finish.ts — a second finish: the message, handed over as is
import { WorkflowFinish } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";

@WorkflowFinish({
  name: "hand-over-workflow-finish",
  description: "A message the desk does not answer, for the team",
  output: WorkflowStartTextDto,
})
export class HandOverWorkflowFinish {}
```

```ts file=src/desk/routers/main.router.ts
// routers/main.router.ts — `prompt` says how to choose, `routes` what each choice means, `input`
// what it decides on
import { DecidedBy, Router } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { SupportAgent } from "../agents/support.agent.js";
import { HandOverWorkflowFinish } from "../workflow-finishes/hand-over.workflow-finish.js";

@Router({
  name: "main-router",
  description: "Sends the message to the agent that answers it, or hands it over",
  decidedBy: DecidedBy.Model,
  prompt: "Pick who handles the customer's message.",
  model: "typesafe/jev-1.13",
  input: { message: WorkflowStartTextDto },
  maxVisits: 1,
  routes: [
    { prompt: "Questions about orders", target: SupportAgent },
    {
      prompt: "Stop and hand the message over: it is not about an order",
      target: HandOverWorkflowFinish,
    },
  ],
})
export class MainRouter {}
```

```ts file=src/desk/desk.workflow.ts
// desk.workflow.ts — the module: the paths (`flow`), defaults, providers; limits in settings()
import { Workflow, WorkflowSettings, route, start, type WorkflowDefinition } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { usd } from "agboss/units";
import { SupportAgent } from "./agents/support.agent.js";
import { MainRouter } from "./routers/main.router.js";
import { OrderBook } from "./services/order-book.service.js";
import { ChatWorkflowFinish } from "./workflow-finishes/chat.workflow-finish.js";
import { HandOverWorkflowFinish } from "./workflow-finishes/hand-over.workflow-finish.js";
import { ChatWorkflowStart } from "./workflow-starts/chat.workflow-start.js";

@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  flow: [
    start(ChatWorkflowStart)
      .returns(WorkflowStartTextDto) // what the step put on the path: its scope
      .toRouter(MainRouter)
      .chooseOne(
        // one route per @Router route, each continued to its end
        route(SupportAgent)
          .toFinish(ChatWorkflowFinish),
        route(HandOverWorkflowFinish),
      ),
  ],
  defaults: {
    models: { temperature: 0 },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 4 },
    history: { limit: 5 },
  },
  maxSteps: 4,
  providers: [OrderBook],
})
export class DeskWorkflow implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perRun: { cost: usd(0.05) }, perDay: { cost: usd(1) } })
      .build();
  }
}
```

The test drives it by script — no model, no network:

```ts file=tests/desk.test.ts
import { expect } from "vitest";
import { callTool, replyWith, routeTo, testWith } from "agboss/testing";
import { DeskWorkflow } from "../src/desk/desk.workflow.js";
import { MainRouter } from "../src/desk/routers/main.router.js";
import { SupportAgent } from "../src/desk/agents/support.agent.js";
import { OrderBook } from "../src/desk/services/order-book.service.js";
import { OrderStatus } from "../src/desk/tools/order-status.tool.js";
import { ChatWorkflowStart } from "../src/desk/workflow-starts/chat.workflow-start.js";
import { ChatWorkflowFinish } from "../src/desk/workflow-finishes/chat.workflow-finish.js";

const test = testWith(DeskWorkflow);

test("an order question goes to support, which looks the order up", async ({ app, mockLlm }) => {
  mockLlm(MainRouter).thenReturn(routeTo(SupportAgent));
  mockLlm(SupportAgent).thenReturn(
    callTool(OrderStatus, { orderId: "7" }),
    replyWith("Order 7 has shipped."),
  );

  const result = await app.execute(ChatWorkflowStart, { text: "where is order 7?" });

  expect(result).toFollowPath([ChatWorkflowStart, MainRouter, SupportAgent, ChatWorkflowFinish]);
  expect(result).toFinishWith(ChatWorkflowFinish, { text: "Order 7 has shipped." });
});

test("a service is replaced by a mock", async ({ app, mockLlm, mockOf }) => {
  mockOf(OrderBook).statusOf.mockResolvedValue("order 7 lost");
  mockLlm(MainRouter).thenReturn(routeTo(SupportAgent));
  mockLlm(SupportAgent).thenReturn(callTool(OrderStatus, { orderId: "7" }), replyWith("Lost."));

  await app.execute(ChatWorkflowStart, { text: "where is order 7?" });

  expect(mockOf(OrderBook).statusOf.mock.calls).toEqual([["7"]]);
});
```

```ts file=vitest.config.ts
// vitest.config.ts — registers the workflow matchers (toFollowPath, toFinishWith, …)
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], setupFiles: ["agboss/testing/setup"] },
});
```

**Adding an agent** = its `agents/<name>.agent.ts` (+ `<name>.prompt.md`), one route in its
router's `routes`, and its path in the router's `chooseOne(…)` (`route(NewAgent).toFinish(…)`).
**Adding a tool** = `tools/<name>.dto.ts` + `tools/<name>.tool.ts`, listed in an agent's `tools`; a
service it needs goes in `providers`. `agboss generate <kind> <name> --workflow <path>` writes and
wires both, then regenerates the types. A project's `npm run types` (`agboss check`) writes
`.agboss/types.d.ts` (git-ignored, regenerated on install); its `tsconfig.json` includes it.

### The flow: paths

`@Workflow({ flow: [...] })` is a list of paths, each from a source to its finishes — built into
one LangGraph `StateGraph` and checked at assembly. A path reads left to right:

- **Sources:** `start(Start)` (where an execution begins); `agent(X)` / `router(R)` / `action(A)` —
  the path of a node reached from two places (a review loop), written once.
- **Steps:** `.toAgent(X)`, `.toRouter(R)`, `.toAction(A)`, `.toFinish(F)`; `.returns(Dto, …)` says
  what the step before put on the path (its **scope**: later nodes read their `input` fields from
  it, `[input.missing-on-path]` when no path brings one); `.chooseOne(route(X)…)` — the router's
  choice, one `route(…)` per `@Router` route; `.switch(caseOf(Dto)…)` — a branch per variant of a
  `oneOf(…)` output; `.onError(ErrorClass, toAction(…)… | toAgent(…)… | toFinish(…))` — the side
  path when the step before throws that class (its subclasses, or an error caused by it), written
  before the step's `.returns(…)`.
- **Node kinds:** `@WorkflowStart` (input: a DTO, a list or a map of fields; input guards),
  `@Router`, `@Agent` (`input` fields, `output` — answered through answer tools, or text without
  them), `@Action` (code, no model: `execute(input)`; its execution through `deps: [ExecutionContext]`), `@WorkflowFinish`
  (output DTO, output guards). `app.execute(Start, input)` is typed by the generated tables:
  `input` is the start's input, `result.output` the finishes' outputs.
- **Assembly rules** fail before any model call with **all** violations at once (`GraphRuleError`,
  stable codes `flow.*` / `graph.*` / `input.*` / `io.*` / `router.*`): names end with their kind
  (`-agent`, `-router`, `-action`, `-workflow-start`, `-workflow-finish`, `-workflow`) and are unique
  in the application (`[name.kind-suffix]`, `[graph.duplicate-node-name]`); DTO classes on paths
  end with `Dto` (`[dto.name]`); a path ends in a finish; a router's `chooseOne` lists exactly its
  routes (`[router.routes-mismatch]`); a node on a cycle has `maxVisits`. No field reads an outdated
  value — one built from an older version of what was renewed since (`[input.outdated-on-path]`,
  #271); in a cycle of classes built from each other the reviewer's `output` says what its answers
  are about, `about(OfferDraftDto, oneOf(…))` (`[io.ambiguous-cycle]`). At run time the scope holds
  current values only: a write moves the older value and everything built from it to
  `outdatedValues` (`result.record`, `outdated: { byValueId, reason: OutdatedReason… }`), one
  `onValuesOutdated` event per cascade (Wiki → Path-scope).

<!-- snippet-context
import { Action, Agent, VisitsLimitExceededError, Workflow, WorkflowFinish, WorkflowStart, agent, caseOf, start, toAction } from "agboss";
import { Flag, Text, about, oneOf } from "agboss/dto";

export class ShortlistDto {
  @Text({ prompt: "the shortlisted candidates" })
  candidates!: string;
}
export class OfferDraftDto {
  @Text({ prompt: "the offer text" })
  text!: string;
}
export class ChangesRequestedDto {
  @Text({ prompt: "what to change" })
  notes!: string;
}
export class DraftApprovedDto {
  @Text({ prompt: "a note for the record", optional: true })
  note?: string;
}
export class OfferSentDto {
  @Flag({ prompt: "the offer was delivered" })
  delivered!: boolean;
}
@WorkflowStart({ name: "offer-workflow-start", description: "A shortlist", input: ShortlistDto })
export class OfferWorkflowStart {}
@Agent({ name: "draft-agent", description: "Drafts the offer", prompt: "Draft the offer.", model: "moonshotai/kimi-k2.6", input: { shortlist: ShortlistDto }, output: OfferDraftDto })
export class DraftAgent {}
@Agent({ name: "reviewer-agent", description: "Reviews the draft", prompt: "Review the draft.", model: "moonshotai/kimi-k2.6", input: { draft: OfferDraftDto }, output: about(OfferDraftDto, oneOf(ChangesRequestedDto, DraftApprovedDto)) })
export class ReviewerAgent {}
@Agent({ name: "editor-agent", description: "Rewrites the draft", prompt: "Rewrite the draft.", model: "moonshotai/kimi-k2.6", input: { draft: OfferDraftDto, changes: ChangesRequestedDto }, output: OfferDraftDto, maxVisits: 2 })
export class EditorAgent {}
@Action({ name: "notify-recruiter-action", description: "Tells the recruiter", input: { draft: OfferDraftDto } })
export class NotifyRecruiterAction {
  async execute(): Promise<void> {}
}
@Action({ name: "send-offer-action", description: "Sends the offer", input: { draft: OfferDraftDto }, output: OfferSentDto })
export class SendOfferAction {
  execute(): Promise<OfferSentDto> {
    return Promise.resolve({ delivered: true });
  }
}
@WorkflowFinish({ name: "offer-failed-workflow-finish", description: "No offer", output: OfferDraftDto })
export class OfferFailedWorkflowFinish {}
@WorkflowFinish({ name: "offer-sent-workflow-finish", description: "Sent", output: OfferSentDto })
export class OfferSentWorkflowFinish {}
// @snippet
@Workflow({ name: "offer-workflow", version: "1.0.0", flow: offerPaths })
export class OfferWorkflow {}
-->

```ts
// a review loop: the reviewer is reached from the draft and from the editor — its path is its own
export const offerPaths = [
  start(OfferWorkflowStart)
    .returns(ShortlistDto)
    .toAgent(DraftAgent)
    .returns(OfferDraftDto)
    .toAgent(ReviewerAgent),

  agent(ReviewerAgent)
    .switch(
      caseOf(ChangesRequestedDto)
        .toAgent(EditorAgent)
        .onError(
          VisitsLimitExceededError, // the editor's maxVisits spent: tell the recruiter, finish
          toAction(NotifyRecruiterAction)
            .toFinish(OfferFailedWorkflowFinish),
        )
        .returns(OfferDraftDto)
        .toAgent(ReviewerAgent),
      caseOf(DraftApprovedDto)
        .toAction(SendOfferAction)
        .returns(OfferSentDto)
        .toFinish(OfferSentWorkflowFinish),
    ),
] as const;
```

- **Routers:** a route **to a workflow finish** is worded as a stop instruction
  ("Stop and send the answer: …"), never "the answer is ready". `decidedBy` names who decides
  (#280): `DecidedBy.Model` — the router's `model` (a decision model like Jev, or a chat model)
  picks a route from its `input`; `DecidedBy.Code` — the class's `route(input: InputOf<Self>)`
  (`implements RouterHandler<Self>`, `deps` like an action, the execution through
  `deps: [ExecutionContext]`) returns `Route<Self>`, the generated union of its targets — no model
  call, cost 0, a target outside `routes` does not compile. Options are discriminated by
  `decidedBy` (`model` / `prompt` / a route `prompt` on a code router do not compile); both kinds
  take `input` (non-empty, `[router.empty-input]`), `maxVisits` and, on routes, `spawn` /
  `failure` — options of a parallel launch (#273; defaults `Always` + `FailFast`, a code router's
  route `OnDemand`), an assembly error with `.chooseOne(…)` (`[router.policy-with-choose-one]`). A router that fails **fails the run** unless an
  `.onError(…)` right after it takes it: `RouterFailedError` (`step.router`: `route()` threw or
  the model call failed, the original as `cause` — `.onError(DomainError, …)` catches it through
  the cause) or `RouterDecisionError` (`step.router.invalid-decision`, a `RouterFailedError`: an
  answer outside its routes, never retried).
- `agboss describe` prints the flow in this grammar; Studio draws the same graph.

### Components and dependency injection

- **One class per file, folders by kind:** `workflow-starts/`, `routers/`, `agents/`, `actions/`,
  `workflow-finishes/`, `tools/`, `services/`, `mcp/`, `rag/`, `environments/`; files
  `*.workflow-start.ts`, `*.router.ts`, `*.agent.ts` (+ `*.prompt.md`), `*.action.ts`,
  `*.workflow-finish.ts`, `*.tool.ts`, `*.dto.ts`, `*.service.ts`, `*.server.ts` + `*.mcp.ts`,
  `*.rag.ts`, `*.helper.ts`.
- **Decorator = metadata, constructor = dependencies, methods = a contract:** `implements` for your
  own (`ToolHandler<In, Out>`, `ActionHandler<Self>`, `RouterHandler<Self>`, `JudgeHandler`,
  `RagConnector`), `extends` +
  `override` for a standard implementation (`McpServerClient`, `SqliteFtsConnector`). Prompts are
  `prompt` (inline) or `promptUrls` (files next to the component) plus `promptVariables`;
  `{{variables}}` are checked at assembly (`[prompt.unknown-variable]`). What a node reads comes in
  its input message (`### field (from producer)`), never as `{{input.…}}` in instructions
  (`[prompt.input-in-instructions]`).
- **`deps`, one contract for every kind** (`@Injectable`, `@Tool`, `@McpTool`, `@Rag`, `@Judge`,
  `@Action`, a code `@Router`, `@Guardrail`, `@PiiPolicy`, `@Channel`, inbound adapters): `deps` are checked
  against the constructor by the compiler and injected by the container. A token is a class or an
  `InjectionToken<T>`; values go in with `provide(TOKEN, value)` (a raw `{ provide, useValue }`
  does not compile). A dependency without a provider fails at assembly (`Consumer: "TOKEN" is not
registered …`); a class in `providers` without a decorator fails with `[di.undecorated-provider]`.
- **One container per application instance, no scopes (#261):** one instance per class (a class
  listed by two workflows is one instance), created at start. A dependency on a contract gets the
  one listed class that `extends` it (two → `[di.ambiguous-implementation]`); one token with
  different values → `[di.conflicting-values]`; no `new`: `provide(Class, …)` fails with
  `[di.instance-provider]`. Hooks, each optional: `implements OnInit, OnStart, OnStop, OnDestroy` —
  `onInit` (dependencies first) → `onStart` at start (a failure stops it, naming the component and
  the hook); `app.close()` → `onStop` (no new executions) → the running ones awaited → `onDestroy`
  (dependants first; failures collected into one error).
- **Components keep no state:** another instance may continue an execution after a pause, so a
  component reads the execution from `ExecutionContext`, data that outlive a step live in the graph
  state, caches and deduplication are your own service over external storage. Lint
  (`agboss/no-component-state`) flags `this.x = …` outside the constructor of any component.

<!-- snippet-context
import { Injectable } from "agboss";
interface RedisClient {
  sAdd(key: string, member: string): Promise<number>;
}
@Injectable()
export class RedisClientProvider {
  readonly client: RedisClient = { sAdd: () => Promise.resolve(1) };
}
// @snippet
-->

```ts
@Injectable({ deps: [RedisClientProvider] })
export class SeenJobsRepository {
  constructor(private readonly redisClientProvider: RedisClientProvider) {}

  async markSeen(executionId: string, jobId: string): Promise<boolean> {
    const added: number = await this.redisClientProvider.client.sAdd(`seen:${executionId}`, jobId);
    return added === 1; // the state lives in Redis: any instance continues the execution
  }
}
```

- **Data are DTO classes** (`agboss/dto`): `@Text`, `@Integer`, `@Flag`, `@OneOf`,
  `@ListOf`, `@Nested`, …; plain data, no methods; on paths wrapped as `listOf(Dto)`,
  `oneOf(A, B)`, `optional(Dto)`, `variant(Dto, "tag")`. Standard ones: `WorkflowStartTextDto`,
  `WorkflowFinishTextDto`, `ToolCallApprovalDecisionDto`, `RagSearchResultDto`, `PlainTextDto`
  (Wiki → Standard-DTOs). zod stays inside the framework.
- **Tool names** are unique over what a model sees — local, MCP, `search_<rag>` and an agent's answer
  tools (`answer-<dto>`) — else `[tool.duplicate-name]`. A tool with a `channel` (approval) needs that
  channel in `@Workflow({ channelClasses })`, else assembly fails.
- **Observers are registered**, not discovered: `@Workflow({ observers: [...] })`, typed hooks
  (`implements OnToolEnd, …`); an observer with no or a misspelled hook fails assembly
  (`[observer.no-hooks]`, `[observer.unknown-hook]`), one that throws is a warning. Workflow
  events: `onWorkflowStart` once per run, `onWorkflowPause` / `onWorkflowResume` around a pause,
  `onWorkflowEnd` / `onError` when the run ends — also after a resume (a cancelled paused run:
  `onError`, `WorkflowCancelledError`); all events carry the run's `runId` and real `threadId`.
  A request refused before a run starts or is located (another owner's thread, nothing paused, an
  unknown thread, an invalid start input) → `onRunRejected` (`operation`, `threadId?`, `code`,
  `message` without input values, no `runId`), still thrown; `IncompatibleResumeError` → `onError`
  on the paused run (its `runId`), which stays paused. `onValuesOutdated` (`ValuesOutdatedEvent`:
  `executionId`, `threadId`, `workflow`, `step`, `trigger`, `outdated` — no DTO values) once per
  outdating cascade, never empty.
- **Memory** (`agboss/memory`): agents see the thread's last `defaults.history.limit` turns
  (`start <name>: <input>` / `finish <name>: <output>`, + `compaction` summaries) as a message of
  their own; `@Agent({ memoryStrategy })` replaces that for one agent (`extends BaseMemoryStrategy`).
- **Knowledge bases:** a `@Rag` class implementing `RagConnector`, bound per agent with
  `rag: [{ use, mode: RagMode.Tool | RagMode.Context }]`. **MCP:** `@McpServer`
  (`extends McpServerClient`) in `mcp: [...]`, its tools as `@McpTool` classes.

### Environments

The app's settings live in `environments/` next to the workflow file: the contract in
`environment.ts` (`declare module "agboss" { interface Environment { … } }`), the values in
`<name>.environment.ts` (`export default defineEnvironment({ … })`, `fromEnv("VAR", { default,
secret })` for process variables). Services inject them with `ENV` (`@Injectable({ deps: [ENV] })`,
`constructor(env: Environment)`), never `process.env`. `--env <name>` / `createApp(W, { env })` /
`testWith(W, { env | environment })` pick one (default `dev`); a missing value fails at start
naming it. Model provider keys stay process variables (`EnvironmentVariable.named`). README →
Environments has the full example.

### Judges and decision models

`@Agent({ judges: [AnswerGrounded], maxRetries: 1 })` runs each `@Judge({ name, model, deps })`
(`implements JudgeHandler`) on the agent's reply; a rejection goes back to the agent with the
feedback, and when retries are spent the run throws `QualityGateError`. A judge's own model is a chat
model (`judgeModel.invoke`, `deps: [JudgeModel]`) or a **decision model**
(`judgeModel.decide({ state, questions })` with
`Decision.noul` / `Decision.choice` / `Decision.score`, answers typed by the questions; `DECISION_MODELS`
served by `DecisionsModelProvider`). The wrong call for the model's kind throws `ModelKindError`.
Routers and guards use decision models too. README → Quality gates has a full judge.

### Runs: context, limits, errors

- `app.execute(Start, input, { thread, owner, signal, metadata, onStream })` → `ExecutionOutput`
  (`output` is the finish's DTO, `finish`, `path`, `spend`, `thread`, `runId`);
  `app.resume(thread, decision)` continues a paused run; `app.cancel(thread)` aborts a running one
  (`WorkflowCancelledError`) or drops a paused one (`resume` → `NotPausedError`). A thread with an
  `owner` rejects another owner (`ThreadOwnerError`).
- **`ExecutionContext` (#280)** is the one context of an execution, injected through the
  constructor (`deps: [ExecutionContext]`, a parameter named `executionContext`) into any component;
  there is no `ctx` parameter (tools, actions, judges get only their input). Read-only data:
  `executionId`, `threadId`, `ownerId`, `signal`, `workflow` (`type`, `name`, `version`,
  `startedVersion`), `step` (`component`, `nodeId`, `visitNumber`, `idempotencyKey` =
  `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`, `callId` during a tool
  call, `itemIndex`, `copyNumber`), the tree (`parent`, `root`, `depth`, `executionOf(W)`; one level
  until #263). Every read gives the current step (an `AsyncLocalStorage` frame per node visit and per
  tool call, closed when it ends); outside an execution or after its step ended a read throws
  `ExecutionContextUnavailableError` (`context.unavailable`). No input, no metadata in it: domain
  data come through `input`. Units: `new X(testExecutionContext(), fakes)`. Framework code reads the
  run with the internal `extractRunContext` — never by parsing `configurable`.
- **Spend of services that are not models** (#280 S43): `deps: [SpendRecorder]` in a `@Tool` /
  `@Action`, `this.spendRecorder.record({ service: "serp-api", cost: usd(0.002) })` — into the
  current tool call's or step's spend (`tool:<name>` / `action:<name>`), counted in the money
  limits; outside a frame `[spend.outside-step]`. In a tool call `executionContext.signal` is the
  call's: the execution's signal and the tool's `timeoutMs` timer (S45).
- **Limits:** `@Workflow({ maxSteps })` — visits of agents and routers in one run (default:
  (agents + routers) × 3); a node's `maxVisits`; money in `settings()`:
  `.limits({ perRun: { cost }, perDay: { cost } })` (values with units: `usd()`). Hitting one
  **fails the run** — unless an `.onError(…)` takes it — with `LimitExceededError` naming the key
  (`maxSteps`, `<node>.maxVisits` as `VisitsLimitExceededError`, `limits.perRun.cost`,
  `limits.perDay.cost`; money: `BudgetExceededError`). `perDay.cost` requires `perRun.cost`
  (`[limits.per-run-required]`).
- **Errors** (root entry) are `AGBossError`s with stable `code`s (`limit` ⊃ `limit.budget`,
  `limit.visits`, `step.agent` / `step.action` / `step.router` ⊃ `step.router.invalid-decision`,
  `workflow.cancelled`, …); a new error
  class gets a `static code`. `.onError` matches by class, so a subclass is caught by its parent's
  side path.

### Testing

- Whole workflows: `testWith(Workflow, options?)` from `agboss/testing` gives Vitest fixtures
  `app`, `mockLlm`, `mockOf`, `mcpOf`, `recoverApp`; models answer by script — `replyWith(text)` or
  `replyWith(Dto, value)` (a structured answer), `callTool(Tool, args)` (args typed by the tool's
  input DTO), `routeTo(Target)`, `decideWith(answers)` (a decision judge),
  `failWith(ModelFailure.Timeout)`; the network is blocked. Matchers by class: `toFollowPath`,
  `toFinishWith`, … (`setupFiles: ["agboss/testing/setup"]`).
- A recorded run instead of scripts: `testWith(W, { vcr: { cassetteName, dir, mode: VCRMode.REPLAY } })`
  — an unrecorded call throws `CassetteMissingError` (REPLAY by default under `CI`).
- Units: `toolOf(new Tool(testExecutionContext(), fakes)).invoke(input)` for a tool,
  `testExecutionContext({ … })` for any component's `ExecutionContext`, fakes from
  `@langchain/core/utils/testing`. Tests never call a real model; real-model checks are `make smoke`.

### Imports

An example (and any project) imports only the public entries: the root `agboss` (decorators,
DI, the path builder, settings, environments, observers, judges and decisions, `createApp`, errors,
types), `agboss/dto` (+ the DTO wrappers), `/units`, `/models`, `/testing` (+ `/testing/setup`), and
the integrations `/mcp`, `/rag`, `/a2a`, `/memory`. ESLint enforces it from
`packages/agboss/package.json#exports` minus `deprecatedExports` (`scripts/public-entries.mjs`): a
new entry is allowed by adding it there, never by an `eslint-disable`. `/core`, `/graph`, `/router`,
`/tool`, `/channels` are deprecated re-exports; `agboss migrate imports` rewrites them. The root
import has no side effects (load tracing, MCP, SQLite lazily), and each name has one meaning across
entries. A public surface change updates the api-extractor reports (`npm run api:update` →
`packages/agboss/api/*.api.md`). The framework never imports `examples/` (ESLint-enforced).

### Quality gates

`make check` = `npm run check`: the root allowlist (`.root-allowlist`), the suppression budget
(`.suppressions.json`), the generated `.agboss/types.d.ts` of the framework's test fixtures
(`npm run check:types`, #272 — before lint and `tsc`), build, the API reports, **compiled docs**,
prettier, ESLint, `tsc` (tests included; the examples' types written first), tests with coverage,
`agboss check` on flow-patterns' two workflows and `agboss check --models` on job-scout. Compiled docs (`scripts/check-docs.mjs`) typecheck
every ` ```ts ` block of README, CLAUDE, QUALITY and WORKFLOW (and `docs/`) against the built
package — a doc whose snippets declare a `@Workflow` gets its `.agboss/types.d.ts` written first —
and check that every `scripts/…`, `npm run …`, `make …` and `agboss …` they mention — and every
`agboss …` the CLI prints — exists. CI also clones the GitHub Wiki and runs
`node scripts/check-docs.mjs --wiki wiki`: the same checks for every Wiki page, plus every link
between pages names an existing page. The Wiki changes outside PRs, so check it before publishing:
`node scripts/check-docs.mjs --wiki ../<repo>.wiki`. Snippet conventions (README, CLAUDE, Wiki alike):

- ` ```ts file=src/x.ts ` — written at that path, so other blocks of the same doc import it.
- A hidden `<!-- snippet-context … -->` comment right before a block supplies imports and
  declarations; a line `// @snippet` in it marks where the block goes (to wrap a fragment). A
  workflow snippet is loaded to write its types: its classes are real (exported), not `declare`d.
- ` ```ts no-check: <reason> ` opts a block out — the reason is required; use it sparingly.
- **One call per line in flow chains** (#289): `start(A)` / `.returns(B)` / `.toFinish(C)`, also
  `route(X)` / `.toFinish(F)`. `*.workflow.ts` and the flow fixtures (`FLOW_FILES` in
  `scripts/flow-style.mjs` = `.prettierignore`) are formatted by `make fmt`
  (`node scripts/format-flows.mjs`), not Prettier, and checked by ESLint
  (`@stylistic/newline-per-chained-call` + the formatting rules Prettier no longer applies there);
  a doc's ts block that builds a path is checked by `check:docs` (`doc:line: … (rule)`).

## Naming grammar (#127)

Names repeat the same patterns everywhere, so one name lets you guess the others (Wiki →
Components):

- **Kind as the suffix, qualifier in front**: `MainRouter`, `CoderAgent`, `ChatWorkflowFinish`;
  a component's `name` the same in kebab-case, its kind last (`main-router`, `coder-agent`,
  `chat-workflow-finish`, `charge-action`, `desk-workflow` — `[name.kind-suffix]`), unique in the
  application. DTO classes end with `Dto` (`OrderRequestDto`, `[dto.name]`); tool DTOs are noun
  pairs from one root (`FileRead` → `FileContent`, `FileWrite` → `FileWritten`).
- **Hierarchy rule (#141)**: a DTO that belongs to a component kind starts with that kind
  (`WorkflowStartTextDto`, `ToolCallApprovalDecisionDto`, `RagSearchResultDto`); paired concepts get paired
  names (`@WorkflowStart` / `@WorkflowFinish`, `WorkflowPauseQuestionDto` / `WorkflowPauseAnswerDto`);
  nothing "chat", "user", "human" or "person" in framework names — a run may be a CI pipeline, an
  approval may come from a system.
- **When + what** for things tied to a moment: `BeforeToolCallJudge`, `AfterToolCallJudge`,
  `BeforeAgentAnswerJudge`.
- **One limit → flat `max…`** (`maxVisits`); **several related → an object** named by what they
  are, the scope stated once (`limits: { perRun: { cost }, perDay: { cost } }`).
- **Closed sets are enums**, not string unions, in the public API.
- **One field name per meaning** across variants (`reason` for every verdict).
- **Full words.** Kept abbreviations: DTO, PII, MCP, RAG, JSON, CSV, CLI, URL, ID, API and the
  command `agboss`.
- Getting something for a component is `…Of` (`schemaOf`, `modelOf`); attaching is
  `<verb>(what).on(target)`; storage contracts are `…Repository` with Spring Data method names.
- **Values with units** — `usd(0.5)`, `seconds(30)`, `minutes(5)` (`agboss/units`), no `Ms` /
  `Usd` in names. `override…` only for replacing what is inherited.

## Conveyor

Stage = the `status:*` label: **Triage → Backlog → In progress → Test → Done** (Done: a human closes the issue).

| Stage              | Skill          | Output                                                                                                                     |
| ------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Triage             | `triage`       | business side (why / does / does not / constraints / acceptance criteria AC1…) in the issue; parent + sub-issues if needed |
| Backlog            | `spec-session` | spec, plan, tests + manual checks mapped to every AC, test cases in the issue                                              |
| In progress → Test | `implement`    | parallel waves; branch + PR (`Refs #N`) per issue, merged to `main`; manual-test handoff                                   |

Quizzes: `.claude/skills/QUIZ.md`. Stages: `scripts/ticket.sh status <N> <Status>`.

## Hard rules

- Read `WORKFLOW.md` (tracker, wiki, branches, PRs) and `QUALITY.md` (code, types, agents, FinOps,
  tests) before writing code.
- Tracker is GitHub Issues via `gh`. Every change belongs to an issue.
- Never commit to `main` directly. Branch from `main`: `<type>/<issue>-<slug>`.
- Every domain concept gets a named type; reusable code is generic.
- Every model call records usage; models come only from the registry.
- Never lower coverage thresholds, disable lint rules, or add `eslint-disable` / `@ts-ignore`
  to get green. Fix the code or stop and report.
- The gate enforces it (#180): `.suppressions.json` is a budget of every `eslint-disable`,
  `@ts-ignore`, `as any` and `as unknown as` — `make check` fails when a count goes up, and when it
  goes down until the budget is lowered (`node scripts/check-suppressions.mjs --write`). No
  file-scope `/* eslint-disable */`, ever. Tests must assert (`requireAssertions`) and must not fake
  framework failures (e.g. an interrupt by its name). The repo root is allow-listed
  (`.root-allowlist`): notes and specs go to Issues / Wiki.
- Tests never call a real LLM. A workflow is tested with `agboss/testing` (`testWith`: models
  by script, MCP servers stubbed, network blocked); units use fakes from `@langchain/core/utils/testing`.
- Read existing code before planning — the spec may be stale, the code is not.
- **No specs, plans or docs as files.** Specs and implementation plans → GitHub Issues (bodies via
  stdin). Docs → GitHub Wiki via `scripts/wiki.sh`. **ALWAYS update the `../<repo>.wiki` repository directly whenever making API, DSL, or architectural changes so that the wiki is always up-to-date** — checked with `node scripts/check-docs.mjs --wiki ../<repo>.wiki` before `scripts/wiki.sh publish`, and by CI. Decisions → wiki pages `ADR-NNNN-Title`.
- Inside the framework, `src/routers` never imports graph/agents/prompts, and the rest imports it
  only via `src/routers/index.ts` (ESLint-enforced; the same for `src/tools` and `src/terns`).
- **Example code before spec**: a new decorator or a new parameter enters a spec only after example
  code using it is agreed.
- New names follow the naming grammar (above, #127).
- Screenshots and scratch output go to `.artifacts/` (git-ignored).

## Layout

```
packages/agboss/        the framework (npm package `agboss`; builds to dist/; no command — see -cli)
  src/
    index.ts        the root entry `agboss` (public/: components, flow, observers, app) + errors.ts
    app/            createApp → app.execute / resume / close; app-deps.ts — production wiring (model gateway,
                    MCP, ledger, Terns, tracing), every part replaceable
    testing/        `agboss/testing`: testWith (Vitest fixtures), scripted gateway, matchers, setup.ts
    components/     @Tool @Agent @McpServer @McpTool @Rag @Injectable @Workflow, DI container, workflowOf
    dto/            `agboss/dto`: field decorators, DTO schemas and validation, standard/ DTOs
    units/          `agboss/units`: usd(), seconds(), minutes()
    workflow.ts     the assembled workflow type
    config/         typed config schema, profiles (YAML overlays), defaults resolution
    rag/            knowledge-base contract (RagConnector) + reference SQLite FTS5 connector
    flow/           the paths (#272): builder.ts (start/agent/router/action/route/caseOf/to…), ast.ts,
                    decorators/ (@WorkflowStart @Router @Agent @Action @WorkflowFinish @Workflow),
                    dto-wrappers.ts, handlers.ts, print.ts (the grammar printed); analyse/ (path walk,
                    scope and data flow, rules/), types/ (`.agboss/types.d.ts` generation),
                    runtime/ (the StateGraph per workflow: build.ts, state.ts, scope, runners/,
                    limits, onError, input messages, records)
    graph/          the agent loop (agent-loop/: its subgraph, tools, approval, judges), knowledge,
                    rule-error.ts, limits.ts, settings.ts, studio-graph.ts
    llm/  routers/  tools/  guards/  terns/  run/  pause/  finops/  eval/  tracing/  prompts/  types/
    loader/, describe/   loadWorkflow (tsx) and describeWorkflow; studio.ts (LangGraph Studio)
    internal.ts     `agboss/internal`: what the CLI is built on — not public, not for projects
  tests/            unit tests (helpers.ts = fakes; fixtures/ = test workflows); routers/ alone; smoke/ = real
  schema/           profile.schema.json (YAML autocomplete)
packages/agboss-cli/    the `agboss` / `agboss` command (#205; depends on agboss, same version)
  src/
    cli/            main.ts → run-cli.ts (argv → exit code 0/1/2 usage/3 project/4 conflict, --json
                    envelope), commands.ts (one option schema per command: parser + help), terminal helpers
    scaffold/       `agboss create` / `agboss generate` (templates/ next to src/)
    migrate/        `agboss migrate imports` (#195): rewrites the old entries' imports to the new ones
    chat.ts, cli.ts, check.ts, describe.ts, rag-index.ts, eval/   command handlers
  tests/            CLI tests; workflows come from the framework's tests/fixtures
  bin/              the CLI launcher (bin names `agboss` and `agboss`)
examples/job-scout/          the example (package job-scout-example; depends on agboss)
  src/              job-scout.workflow.ts (one path a turn), studio.ts; workflow-starts/ (*.workflow-start.ts), routers/
                    (*.router.ts), agents/ (*.agent.ts + *.prompt.md), workflow-finishes/
                    (*.workflow-finish.ts), tools/ (*.tool.ts +
                    *.dto.ts), services/ (*.service.ts), mcp/ (*.server.ts, *.mcp.ts, *.dto.ts),
                    rag/ (*.rag.ts), helpers/ (*.helper.ts), config/, scripts/, data/
  tests/  profiles/  golden/
examples/flow-patterns/      the flow's patterns (package flow-patterns-example, #295): src/offer/ (a review loop),
                    src/credit/ (a code router beside a model router), one *.workflow.ts each; tests/
scripts/        the gate's checks (check-root, check-suppressions, check-docs + docs/, api-report,
                public-entries, eslint-component-state), bootstrap-repo, bootstrap-labels, ticket, wiki,
                langfuse, coverage-badge
../<repo>.wiki  GitHub Wiki working copy (separate git repo, never inside this repo)
```
