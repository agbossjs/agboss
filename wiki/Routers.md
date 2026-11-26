# Routers

Two things carry the name: the **`@Router` flow node** — a component that picks where a run goes
next — and the **router engine** underneath, which picks one option for a piece of text and knows
nothing about graphs or agents.

## `@Router` — a router as a flow node

<!--
```ts file=agents.ts
import { inline, Agent, WorkflowFinish, WorkflowStart } from "@agboss/core";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
const model = "moonshotai/kimi-k2.6";
export class CodeDto {
  @Text({ prompt: "the code" })
  code!: string;
}
export class ReviewDto {
  @Text({ prompt: "the review" })
  notes!: string;
}
@WorkflowStart({ name: "task-workflow-start", description: "A task", input: WorkflowStartTextDto }) export class TaskWorkflowStart {}
@Agent({ name: "coder-agent", description: "Writes code", prompt: inline("Write the code."), model, input: { task: WorkflowStartTextDto }, output: CodeDto, executionLimits: { maxVisits: 3 } }) export class CoderAgent {}
@Agent({ name: "reviewer-agent", description: "Reviews the code", prompt: inline("Review the code."), model, input: { code: CodeDto }, output: ReviewDto }) export class ReviewerAgent {}
@WorkflowFinish({ name: "pull-request-workflow-finish", description: "The pull request", output: CodeDto }) export class PullRequestWorkflowFinish {}
@Agent({ name: "profiler-agent", description: "Reads the resume", prompt: inline("Read the resume."), model }) export class ProfilerAgent {}
@Agent({ name: "scout-agent", description: "Finds jobs", prompt: inline("Find jobs."), model }) export class ScoutAgent {}
@Agent({ name: "shortlist-agent", description: "Keeps the shortlist", prompt: inline("Keep the shortlist."), model }) export class ShortlistAgent {}
@WorkflowStart({ name: "chat-workflow-start", description: "A message", input: WorkflowStartTextDto }) export class ChatWorkflowStart {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The answer", output: WorkflowFinishTextDto }) export class ChatWorkflowFinish {}
```
-->

<!-- snippet-context
import { CoderAgent, PullRequestWorkflowFinish, ReviewDto } from "./agents.js";
-->

```ts file=review-gate.router.ts
import { inline, DecidedBy, Router } from "@agboss/core";

@Router({
  name: "review-gate-router",
  description: "Sends the code back or opens the pull request",
  decidedBy: DecidedBy.Model,
  prompt: inline("Is the review clean?"), // or a file next to the router: prompt: "./review-gate.prompt.md"
  model: "typesafe/jev-1.13", // the router's own model: a decision model, or any chat model
  input: { review: ReviewDto }, // what it decides on, read from the path's scope
  maxVisits: 3, // a bound for the cycles through it
  routes: [
    { prompt: "The review asks for changes", target: CoderAgent },
    { prompt: "Stop and open the pull request: the review is clean", target: PullRequestWorkflowFinish },
  ],
})
export class ReviewGateRouter {}
```

In the flow the router's choice lists the same targets, each continued to its end
([Workflow](Workflow)):

<!-- snippet-context
import { toAgent, toFinish, Ttl } from "@agboss/core";
import { Workflow, onAgent, onStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { CodeDto, CoderAgent, PullRequestWorkflowFinish, ReviewDto, ReviewerAgent, TaskWorkflowStart } from "./agents.js";
import { ReviewGateRouter } from "./review-gate.router.js";
-->

```ts
@Workflow({
  name: "review-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TaskWorkflowStart)
      .toAgent(CoderAgent),

    // the coder is reached from the start and from the router: its own path
    onAgent(CoderAgent)
      .toAgent(ReviewerAgent)
      .toRouter(ReviewGateRouter) // reached from one place: continued inline
      .onRoute(toAgent(CoderAgent)) // one .onRoute(…) per route; the coder is a shared node: it ends here
      .onRoute(toFinish(PullRequestWorkflowFinish)),
  ],
})
export class ReviewWorkflow {}
```

- The router's `prompt` (a `PromptSource`: `inline(…)` or a file) says **how** to choose; each route's `prompt` says **what**
  that choice means. A route's `prompt` is required by its type; `input` is required (`router.empty-input`) — the
  router sees its fields in its input message, like an agent.
- The flow's `.onRoute(…)` paths list exactly the router's `routes` — one each, as sets, the order does not
  matter (`[router.routes-mismatch]` names what is missing or extra). A target is an agent, an
  action, another router or a finish.
- `maxVisits` bounds the cycles: every cycle needs it on at least one of its nodes, a router or an
  agent (`[graph.cycle-without-max-visits]`). A visit past it fails before the model call with
  `LimitError.Visits` (`limit.visits`, `<name>.maxVisits`), which `.onError` right after the
  step can take. `@Workflow({ executionLimits: { maxSteps } })` stays the run-wide limit. `agboss g router` writes
  `maxVisits: 1`.
- Routes are sent **sorted by target name** — declaration order changes neither the request nor its
  fingerprint.
- The model is a **decision model** (`DECISION_MODELS`: Jev, `openai/gpt-6-luna-decisions`, …,
  served by a provider with a `DecisionsDriver` — the router's `modelProvider`: one choice question over the routes, probabilities, exact cost)
  or a **chat model** (answers with the option, validated); without `model`, `defaults.router.model`.
  One route → no model call.
- No guessing: a failed model call (after its provider's retries) fails the step with
  `StepError.Router` (`step.router`, the call's error as `cause`, its spend kept); an answer that is
  not one of its routes, or not a readable answer, with `StepError.RouterDecision`
  (`step.router.invalid-decision`) — never retried ([Errors](#errors)).

**There is no built-in "finish" option**: "return to the user" is a route to a workflow finish.
Word that route as a stop instruction that says when to take it ("Stop and send the answer: …"). A
terse text ("the last answer fully covers the message") made Jev send the turn back to the agent
that had just answered until `maxVisits` failed the run.

### job-scout's main router

<!-- snippet-context
import { inline, DecidedBy, Router } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { ProfilerAgent, ScoutAgent, ShortlistAgent } from "./agents.js";
-->

```ts
@Router({
  name: "main-router",
  description: "Sends the job seeker's message to the agent that answers it",
  decidedBy: DecidedBy.Model,
  prompt: inline("Pick the agent that answers the job seeker's message."),
  model: "typesafe/jev-1.13",
  input: { message: WorkflowStartTextDto }, // the message (and the thread's earlier turns)
  maxVisits: 1,
  routes: [
    { prompt: "Reading the resume and proposing a search brief", target: ProfilerAgent },
    { prompt: "Finding and ranking jobs", target: ScoutAgent },
    { prompt: "Saving chosen jobs to the shortlist, or showing it", target: ShortlistAgent },
  ],
})
export class MainRouter {}
```

One path per turn: the router sends the message to one agent, whose answer finishes the turn
(`.onRoute(toAgent(ScoutAgent).toFinish(ChatWorkflowFinish))`); the thread carries the conversation to the next
turn ([Example](Example)).

## Routers decided by code

Not every decision needs a model: "over the credit limit → approval, otherwise charge" is a rule.
`decidedBy: DecidedBy.Code` hands the choice to the class — `implements RouterHandler<Self>`, whose
`route(input)` returns one of its targets. No model call, cost 0, and the flow is the same as for a
model router (#280).

<!--
```ts file=credit.parts.ts
import { optional } from "@agboss/core";
import { inline, Action, Agent, Injectable, WorkflowFinish, WorkflowStart, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { Bool, Integer, Text } from "@agboss/core/dto";
const model = "moonshotai/kimi-k2.6";
export class OrderDto {
  @Text({ prompt: "the customer who orders" })
  customerId!: string;
  @Integer({ prompt: "the order's total in whole dollars" })
  total!: number;
}
export class ApprovalDto {
  @Bool({ prompt: "whether the order is approved" })
  approved!: boolean;
}
export class ChargeResultDto {
  @Text({ prompt: "the charge's id" })
  chargeId!: string;
}
export class CreditServiceUnavailableError extends Error {}
@Injectable()
export class CreditService {
  limitOf(customerId: string): Promise<number> {
    return Promise.resolve(customerId === "big-spender" ? 10_000 : 100);
  }
}
@WorkflowStart({ name: "order-workflow-start", description: "An order", input: OrderDto })
export class OrderWorkflowStart {}
@Agent({ name: "approval-agent", description: "Approves a large order", prompt: inline("Approve it or not."), model, input: { order: OrderDto }, output: ApprovalDto })
export class ApprovalAgent {}
@Action({ name: "charge-card-action", description: "Charges the card", input: { order: OrderDto, approval: optional(ApprovalDto) }, output: ChargeResultDto })
export class ChargeCardAction implements ActionHandler<ChargeCardAction> {
  execute(input: InputOf<ChargeCardAction>): Promise<OutputOf<ChargeCardAction>> {
    return Promise.resolve({ chargeId: `charge-${input.order.customerId}` });
  }
}
@WorkflowFinish({ name: "charged-workflow-finish", description: "The charge", output: ChargeResultDto })
export class ChargedWorkflowFinish {}
@WorkflowFinish({ name: "order-held-workflow-finish", description: "The order, held", output: OrderDto })
export class OrderHeldWorkflowFinish {}
```
-->

<!-- snippet-context
import { ApprovalAgent, ChargeCardAction, CreditService, OrderDto } from "./credit.parts.js";
-->

```ts file=credit-limit.router.ts
import { DecidedBy, ExecutionContext, Router, type InputOf, type Route, type RouterHandler } from "@agboss/core";

@Router({
  name: "credit-limit-router",
  description: "Sends large orders for approval, charges the rest",
  decidedBy: DecidedBy.Code, // no model, no prompt: route() decides
  input: { order: OrderDto }, // a type only — taken from the path scope
  routes: [ApprovalAgent, ChargeCardAction],
  deps: [ExecutionContext, CreditService], // checked against the constructor
})
export class CreditLimitRouter implements RouterHandler<CreditLimitRouter> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly creditService: CreditService,
  ) {}

  async route(input: InputOf<CreditLimitRouter>): Promise<Route<CreditLimitRouter>> {
    this.executionContext.signal.throwIfAborted();
    const limit: number = await this.creditService.limitOf(input.order.customerId);
    return input.order.total > limit ? ApprovalAgent : ChargeCardAction;
  }
}
```

<!-- snippet-context
import { toAgent, toAction, Ttl } from "@agboss/core";
import { Workflow, onAction, onStart, toFinish } from "@agboss/core";
import { ApprovalAgent, ApprovalDto, ChargeCardAction, ChargeResultDto, ChargedWorkflowFinish, CreditService, CreditServiceUnavailableError, OrderDto, OrderHeldWorkflowFinish, OrderWorkflowStart } from "./credit.parts.js";
import { CreditLimitRouter } from "./credit-limit.router.js";
-->

```ts file=credit.workflow.ts
@Workflow({
  name: "credit-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(OrderWorkflowStart)
      .toRouter(CreditLimitRouter)
      .onError(
        CreditServiceUnavailableError, // thrown by route(): caught through StepError.Router's cause
        toFinish(OrderHeldWorkflowFinish),
      )
      .onRoute(
        toAgent(ApprovalAgent)
          .toAction(ChargeCardAction),
      )
      .onRoute(toAction(ChargeCardAction)), // a shared node: ends here, continued in its own path

    onAction(ChargeCardAction)
      .toFinish(ChargedWorkflowFinish),
  ],
  providers: [CreditService],
})
export class CreditWorkflow {}
```

- **One decorator, options by `decidedBy`.** `DecidedBy.Model` takes `model`, `modelProvider`, `prompt`,
  `promptVariables` and a `prompt` on each route (`routes: [{ prompt, target }]`); `DecidedBy.Code` takes `deps` and
  none of those — `model`, `prompt` or a route `prompt` on a code router does not compile. The
  decorator checks the class too: a code router without `route()`, or a model router with one, does
  not compile.
- **`route(input: InputOf<Self>)`** gets the router's `input` fields from the path scope, each the
  DTO itself (`input.order.total`; `Metadata.createdBy(input.order)` is its producer) — the same as an action. `input` is
  required and non-empty for both kinds (`[router.empty-input]`). Decide by types, enums and
  producers — never by matching text (`text.includes("refund")`): a model turns text into a typed
  DTO first.
- **`Route<Self>`** is the union of the router's targets, generated into `.agboss/types.d.ts` by
  `agboss check` — returning a class outside `routes` does not compile. A cast that gets one past
  the compiler fails the step at run time with `StepError.RouterDecision`.
- **Dependencies through the constructor**, like an action: services in `deps`, the execution as
  `deps: [ExecutionContext]` (`executionContext.step.nodeId` is `credit-limit-router`, its
  `idempotencyKey` `${executionId}:credit-limit-router:${visitNumber}`). Unit-test it without the
  container: `new CreditLimitRouter(testExecutionContext(), fakeCreditService)`.
- **The same flow:** inline after one way in (`.toRouter(R).onRoute(…)`), its own path
  `onRouter(R).onRoute(…)` after two or more; routers chain in any mix (a code router inside a
  model router's `.onRoute(…)`). `agboss describe` lists it under `routers` as
  `credit-limit-router  code — Sends large orders for approval, charges the rest`; its decision
  makes no model call and is not in the run's spend.

### A router in a launch: `chooseMany`

A router may be a **branch of a parallel launch** (#273, #1279): `toRouter(R).chooseMany([toAgent(A),
toAgent(B)])` inside `.inParallel([…])` — the list is R's `routes`, as sets (`[router.routes-mismatch]`),
and R decides which of them are launched, the others never run. A model router's route has its
`prompt` (`[router.no-prompt]`) and decides all its routes in one call — a yes/no per route; a code
router's `route()` returns the targets to launch as a list, `[]` included. A branch the router did not
choose gives an `optional(XDto)` value to the join. There is no per-route launch policy: the 0.1.0
`spawn` and `failure` options (`SpawnPolicy`, `FailurePolicy`) are gone — a sibling branch's failure fails the launch (the other branches are cancelled, the finished ones' open undo records are undone), and a failure a launch may
survive is `.onError(StepError, skip())` on its branch. How a model router decides its routes
is in [Routing patterns](Advanced-Routing#6-a-router-decides-who-is-launched).

## Errors

A router's step fails in two ways (#280 S19), both caught by `.onError(…)` right after the router:

| Error | Code | When |
| --- | --- | --- |
| `StepError.Router` | `step.router` | `route()` threw, or a model router's model call failed — the original error is its `cause` |
| `StepError.RouterDecision` | `step.router.invalid-decision` | the answer is not allowed: a target outside `routes` (a cast), a list outside `chooseMany([…])`, an unknown or unreadable answer from the model — never retried |

Both carry `component` (`{ name }`), `nodeId` and `visitNumber`; `StepError.RouterDecision` is a
sibling of `StepError.Router`, not its subclass (its `reason` says what was wrong): `.onError(StepError.Router, …)` does not take it — catch `StepError.RouterDecision`, or the `StepError` family for both. Matching goes through the cause chain: `.onError(CreditServiceUnavailableError, …)` takes the
service's failure inside `StepError.Router`, as in the credit flow above. A limit
(`LimitError`), a cancel or a pause thrown inside `route()` passes as it is, never wrapped.

## The router engine and `DecisionModel`

Underneath a `@Router` is an engine that picks one option for a piece of text — it knows nothing
about graphs or agents, and it is not a public type (`RouterEngine`, `RouteRequest` and the
`ROUTER_FACTORY` token are in `@agboss/core/internal`). A model router asks a **decision model**
(`DECISION_MODELS`: Jev and the others, on a provider with a `DecisionsDriver`: a `choice` question,
probabilities, the cost the API reports) or a **chat model** (it replies with the option, validated).
Failures (HTTP error, malformed output, unknown option) are `failed` outcomes, never exceptions; a
failed call keeps its error as `cause` (the flow turns it into `StepError.Router`, the other
failures into `StepError.RouterDecision`). One option → decided without a model call.

A component that needs a cheap decision of its own injects the public `DecisionModel` — a `@Tool`, an
`@Action` or a service with `deps: [DecisionModel]`. Its call is checked against the tree's budgets
first, counted in the ledger and traced like a router's, and it takes the model and the provider of
the call (`{ model?, modelProvider? }`, the cascade of the component otherwise) — job-scout's fit judge:

<!-- snippet-context
import { Injectable } from "@agboss/core";
import { DecisionsDriver, ModelProvider } from "@agboss/core/models";
import { secret } from "@agboss/core";
import { seconds } from "@agboss/core/units";
@ModelProvider({ driver: DecisionsDriver({ apiKey: secret("OPENROUTER_API_KEY"), baseUrl: "https://openrouter.ai/api/v1" }), timeout: seconds(30) })
export class DecisionsModelProvider {}
const FIT_QUESTION = "Does the job fit what the candidate wants?";
-->

```ts
import { Decision, DecisionModel } from "@agboss/core";

@Injectable({ deps: [DecisionModel] })
export class JobFitJudge {
  constructor(private readonly decisionModel: DecisionModel) {}

  async fits(profile: string, job: string): Promise<boolean> {
    const { fits } = await this.decisionModel.decide(
      {
        state: `Candidate wants:\n${profile}\n\nJob:\n${job}`,
        questions: { fits: Decision.boolean(FIT_QUESTION) },
      },
      { model: "typesafe/jev-1.13", modelProvider: DecisionsModelProvider },
    );
    return fits.probability > 0.5; // P(yes), as every boolean decision answers
  }
}
```

## Isolation

- Inside the framework, `src/routers` imports only `config`, `finops`, `llm`; the rest of `src`
  imports routers only via `src/routers/index.ts` (ESLint-enforced). The engines' own tests are in
  `packages/agboss/tests/routers/` — plain `RouteRequest` fixtures, no graph, no agents.
- The flow renders the router's input fields and the thread's memory (its `uncompactedTurns` and
  its compaction's summaries, [Memory Management](Memory-Management)) into the engine's `input`.

## Testing

In a workflow test a router answers by script — `routeTo(Target)` — or by a function of the request
([Testing](Testing)):

<!--
```ts file=desk.workflow.ts
import { inline, Agent, DecidedBy, Router, Workflow, WorkflowFinish, WorkflowStart, onStart, toAgent, toFinish, toRouter, Ttl } from "@agboss/core";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
@WorkflowStart({ name: "desk-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class DeskStart {}
@WorkflowFinish({ name: "desk-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class DeskFinish {}
@Agent({ name: "support-agent", description: "Helps", prompt: inline("Help."), model: "moonshotai/kimi-k2.6" })
export class SupportAgent {}
@Agent({ name: "fallback-agent", description: "Anything else", prompt: inline("Answer."), model: "moonshotai/kimi-k2.6" })
export class FallbackAgent {}
@Router({ name: "desk-router", description: "Routes", decidedBy: DecidedBy.Model, prompt: inline("Pick who handles it."), model: "typesafe/jev-1.13", input: { message: WorkflowStartTextDto }, routes: [{ prompt: "Support", target: SupportAgent }, { prompt: "Anything else", target: FallbackAgent }] })
export class DeskRouter {}
@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DeskStart)
      .toRouter(DeskRouter)
      .onRoute(
        toAgent(SupportAgent)
          .toFinish(DeskFinish),
      )
      .onRoute(
        toAgent(FallbackAgent)
          .toFinish(DeskFinish),
      ),
  ],
})
export class Desk {}
```
-->

<!-- snippet-context
import { Desk, DeskFinish, DeskRouter, DeskStart, FallbackAgent, SupportAgent } from "./desk.workflow.js";
-->

```ts
import { expect } from "vitest";
import { replyWith, routeTo, testWith } from "@agboss/core/testing";
import { Application } from "@agboss/core";

@Application({ name: "desk-application", version: "1.0.0", workflows: [Desk] })
class DeskApplication {}

const test = testWith(DeskApplication); // an application, never the workflow itself

test("help goes to support", async ({ app, mockModel }) => {
  mockModel(DeskRouter).respondWith((request) =>
    request.kind === "decision" && request.input.toString().includes("help")
      ? routeTo(SupportAgent)
      : routeTo(FallbackAgent),
  );
  mockModel(SupportAgent).thenReturn(replyWith("On it."));

  const result = await app.execute(DeskStart, { text: "help" });

  expect(result).toFollowPath([DeskStart, DeskRouter, SupportAgent, DeskFinish]);
});
```

`app.router(DeskRouter).routeTo("…")` (the `app` fixture) asks one router alone with its scripted
model.

A code router calls no model, so there is nothing to script — `mockModel(CreditLimitRouter)` throws
and says so. Replace the services its `route()` uses instead:

<!-- snippet-context
import { CreditService, CreditServiceUnavailableError, OrderHeldWorkflowFinish, OrderWorkflowStart } from "./credit.parts.js";
import { CreditLimitRouter } from "./credit-limit.router.js";
import { CreditWorkflow } from "./credit.workflow.js";
-->

```ts
import { expect } from "vitest";
import { testWith } from "@agboss/core/testing";
import { Application } from "@agboss/core";

@Application({ name: "credit-application", version: "1.0.0", workflows: [CreditWorkflow] })
class CreditApplication {}

const test = testWith(CreditApplication); // an application, never the workflow itself

test("the credit service down holds the order", async ({ app, mockService }) => {
  mockService(CreditService).limitOf.mockRejectedValue(new CreditServiceUnavailableError("down"));

  const result = await app.execute(OrderWorkflowStart, { customerId: "c-1", total: 50 });

  expect(result).toFollowPath([OrderWorkflowStart, CreditLimitRouter, OrderHeldWorkflowFinish]);
});
```
