# Routers

Two things carry the name: the **`@Router` flow node** — a component that picks where a run goes
next — and the **router engine** underneath, which picks one option for a piece of text and knows
nothing about graphs or agents.

## `@Router` — a router as a flow node

<!--
```ts file=agents.ts
import { Agent, WorkflowFinish, WorkflowStart } from "agboss";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
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
@Agent({ name: "coder-agent", description: "Writes code", prompt: "Write the code.", model, input: { task: WorkflowStartTextDto }, output: CodeDto, maxVisits: 3 }) export class CoderAgent {}
@Agent({ name: "reviewer-agent", description: "Reviews the code", prompt: "Review the code.", model, input: { code: CodeDto }, output: ReviewDto }) export class ReviewerAgent {}
@WorkflowFinish({ name: "pull-request-workflow-finish", description: "The pull request", output: CodeDto }) export class PullRequestWorkflowFinish {}
@Agent({ name: "profiler-agent", description: "Reads the resume", prompt: "Read the resume.", model }) export class ProfilerAgent {}
@Agent({ name: "scout-agent", description: "Finds jobs", prompt: "Find jobs.", model }) export class ScoutAgent {}
@Agent({ name: "shortlist-agent", description: "Keeps the shortlist", prompt: "Keep the shortlist.", model }) export class ShortlistAgent {}
@WorkflowStart({ name: "chat-workflow-start", description: "A message", input: WorkflowStartTextDto }) export class ChatWorkflowStart {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The answer", output: WorkflowFinishTextDto }) export class ChatWorkflowFinish {}
```
-->

<!-- snippet-context
import { CoderAgent, PullRequestWorkflowFinish, ReviewDto } from "./agents.js";
-->

```ts file=review-gate.router.ts
import { DecidedBy, Router } from "agboss";

@Router({
  name: "review-gate-router",
  description: "Sends the code back or opens the pull request",
  decidedBy: DecidedBy.Model,
  prompt: "Is the review clean?", // or files next to the router: promptUrls: ["./review-gate.prompt.md"]
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
import { Workflow, agent, route, start } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { CodeDto, CoderAgent, PullRequestWorkflowFinish, ReviewDto, ReviewerAgent, TaskWorkflowStart } from "./agents.js";
import { ReviewGateRouter } from "./review-gate.router.js";
-->

```ts
@Workflow({
  name: "review-workflow",
  version: "1.0.0",
  flow: [
    start(TaskWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(CoderAgent),

    // the coder is reached from the start and from the router: its own path
    agent(CoderAgent)
      .returns(CodeDto)
      .toAgent(ReviewerAgent)
      .returns(ReviewDto)
      .toRouter(ReviewGateRouter) // reached from one place: continued inline
      .chooseOne(route(CoderAgent), route(PullRequestWorkflowFinish)),
  ],
})
export class ReviewWorkflow {}
```

- The router's `prompt` (or `promptUrls`) says **how** to choose; each route's `prompt` says **what**
  that choice means. A router without a prompt fails assembly (`router.no-prompt`), an empty route
  text too (`router.empty-route-text`); `input` is required (`router.empty-input`) — the router sees
  its fields in its input message, like an agent.
- The flow's `chooseOne(route(…)…)` lists exactly the router's `routes` — as sets, the order does not
  matter (`[router.routes-mismatch]` names what is missing or extra). A target is an agent, an
  action, another router or a finish.
- `maxVisits` bounds the cycles: every cycle needs it on at least one of its nodes, a router or an
  agent (`[graph.cycle-without-max-visits]`). A visit past it fails before the model call with
  `VisitsLimitExceededError` (`limit.visits`, `<name>.maxVisits`), which `.onError` right after the
  step can take. `@Workflow({ maxSteps })` stays the run-wide limit. `agboss g router` writes
  `maxVisits: 1`.
- Routes are sent **sorted by target name** — declaration order changes neither the request nor its
  fingerprint.
- The model is a **decision model** (`DECISION_MODELS`: Jev, `openai/gpt-6-luna-decisions`, …,
  served by `DecisionsModelProvider`: one choice question over the routes, probabilities, exact cost)
  or a **chat model** (answers with the option, validated); without `model`, `defaults.router.model`.
  One route → no model call.
- No guessing: a failed model call (after its provider's retries) fails the step with
  `RouterFailedError` (`step.router`, the call's error as `cause`, its spend kept); an answer that is
  not one of its routes, or not a readable answer, with `RouterDecisionError`
  (`step.router.invalid-decision`) — never retried ([Errors](#errors)).

**There is no built-in "finish" option**: "return to the user" is a route to a workflow finish.
Word that route as a stop instruction that says when to take it ("Stop and send the answer: …"). A
terse text ("the last answer fully covers the message") made Jev send the turn back to the agent
that had just answered until `maxVisits` failed the run.

### job-scout's main router

<!-- snippet-context
import { DecidedBy, Router } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { ProfilerAgent, ScoutAgent, ShortlistAgent } from "./agents.js";
-->

```ts
@Router({
  name: "main-router",
  description: "Sends the job seeker's message to the agent that answers it",
  decidedBy: DecidedBy.Model,
  prompt: "Pick the agent that answers the job seeker's message.",
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
(`route(ScoutAgent).toFinish(ChatWorkflowFinish)`); the thread carries the conversation to the next
turn ([Example](Example)).

## Routers decided by code

Not every decision needs a model: "over the credit limit → approval, otherwise charge" is a rule.
`decidedBy: DecidedBy.Code` hands the choice to the class — `implements RouterHandler<Self>`, whose
`route(input)` returns one of its targets. No model call, cost 0, and the flow is the same as for a
model router (#280).

<!--
```ts file=credit.parts.ts
import { Action, Agent, Injectable, WorkflowFinish, WorkflowStart, type ActionHandler, type InputOf, type OutputOf } from "agboss";
import { Flag, Integer, Text, optional } from "agboss/dto";
const model = "moonshotai/kimi-k2.6";
export class OrderDto {
  @Text({ prompt: "the customer who orders" })
  customerId!: string;
  @Integer({ prompt: "the order's total in whole dollars" })
  total!: number;
}
export class ApprovalDto {
  @Flag({ prompt: "whether the order is approved" })
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
@Agent({ name: "approval-agent", description: "Approves a large order", prompt: "Approve it or not.", model, input: { order: OrderDto }, output: ApprovalDto })
export class ApprovalAgent {}
@Action({ name: "charge-card-action", description: "Charges the card", input: { order: OrderDto, approval: optional(ApprovalDto) }, output: ChargeResultDto })
export class ChargeCardAction implements ActionHandler<ChargeCardAction> {
  execute(input: InputOf<ChargeCardAction>): Promise<OutputOf<ChargeCardAction>> {
    return Promise.resolve({ chargeId: `charge-${input.order.value.customerId}` });
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
import { DecidedBy, ExecutionContext, Router, type InputOf, type Route, type RouterHandler } from "agboss";

@Router({
  name: "credit-limit-router",
  description: "Sends large orders for approval, charges the rest",
  decidedBy: DecidedBy.Code, // no model, no prompt: route() decides
  input: { order: OrderDto }, // a type only — taken from the path scope
  routes: [{ target: ApprovalAgent }, { target: ChargeCardAction }],
  deps: [ExecutionContext, CreditService], // checked against the constructor
})
export class CreditLimitRouter implements RouterHandler<CreditLimitRouter> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly creditService: CreditService,
  ) {}

  async route(input: InputOf<CreditLimitRouter>): Promise<Route<CreditLimitRouter>> {
    this.executionContext.signal.throwIfAborted();
    const limit: number = await this.creditService.limitOf(input.order.value.customerId);
    return input.order.value.total > limit ? ApprovalAgent : ChargeCardAction;
  }
}
```

<!-- snippet-context
import { Workflow, action, route, start, toFinish } from "agboss";
import { ApprovalAgent, ApprovalDto, ChargeCardAction, ChargeResultDto, ChargedWorkflowFinish, CreditService, CreditServiceUnavailableError, OrderDto, OrderHeldWorkflowFinish, OrderWorkflowStart } from "./credit.parts.js";
import { CreditLimitRouter } from "./credit-limit.router.js";
-->

```ts file=credit.workflow.ts
@Workflow({
  name: "credit-workflow",
  version: "1.0.0",
  flow: [
    start(OrderWorkflowStart)
      .returns(OrderDto)
      .toRouter(CreditLimitRouter)
      .onError(
        CreditServiceUnavailableError, // thrown by route(): caught through RouterFailedError's cause
        toFinish(OrderHeldWorkflowFinish),
      )
      .chooseOne(
        route(ApprovalAgent)
          .returns(ApprovalDto)
          .toAction(ChargeCardAction),
        route(ChargeCardAction), // a shared node: ends here, continued in its own path
      ),

    action(ChargeCardAction)
      .returns(ChargeResultDto)
      .toFinish(ChargedWorkflowFinish),
  ],
  providers: [CreditService],
})
export class CreditWorkflow {}
```

- **One decorator, options by `decidedBy`.** `DecidedBy.Model` takes `model`, `prompt` /
  `promptUrls`, `promptVariables` and a `prompt` on each route; `DecidedBy.Code` takes `deps` and
  none of those — `model`, `prompt` or a route `prompt` on a code router does not compile. The
  decorator checks the class too: a code router without `route()`, or a model router with one, does
  not compile.
- **`route(input: InputOf<Self>)`** gets the router's `input` fields from the path scope, each a
  `Produced<T, P>` (`input.order.value`, `input.order.producer`) — the same as an action. `input` is
  required and non-empty for both kinds (`[router.empty-input]`). Decide by types, enums and
  producers — never by matching text (`text.includes("refund")`): a model turns text into a typed
  DTO first.
- **`Route<Self>`** is the union of the router's targets, generated into `.agboss/types.d.ts` by
  `agboss check` — returning a class outside `routes` does not compile. A cast that gets one past
  the compiler fails the step at run time with `RouterDecisionError`.
- **Dependencies through the constructor**, like an action: services in `deps`, the execution as
  `deps: [ExecutionContext]` (`executionContext.step.nodeId` is `credit-limit-router`, its
  `idempotencyKey` `${executionId}:credit-limit-router:${visitNumber}`). Unit-test it without the
  container: `new CreditLimitRouter(testExecutionContext(), fakeCreditService)`.
- **The same flow:** inline after one way in (`.toRouter(R).chooseOne(…)`), its own path
  `router(R).chooseOne(…)` after two or more; routers chain in any mix (a code router inside a
  model router's `route(…)`). `agboss describe` lists it under `routers` as
  `credit-limit-router  code — Sends large orders for approval, charges the rest`; its decision
  makes no model call and is not in the run's spend.

### `spawn` and `failure`

A route may carry the options of a parallel launch (#273), on both kinds: `spawn:
SpawnPolicy.Always | SpawnPolicy.OnDemand` — the framework launches an `Always` target itself, the
router decides only the `OnDemand` ones — and `failure: FailurePolicy.FailFast | FailurePolicy.Skip`.

| Default | Model router's route | Code router's route |
| --- | --- | --- |
| `spawn` | `SpawnPolicy.Always` | `SpawnPolicy.OnDemand` |
| `failure` | `FailurePolicy.FailFast` | `FailurePolicy.FailFast` |

A model router's `OnDemand` route needs its `prompt`; an `Always` route has none (it is never shown
to the model).

- They apply only before `.toParallelAgents(…)` (#273). With `.chooseOne(…)` every
  route is a choice — `Route<Self>` is every target — and an explicit `spawn` or `failure` fails
  assembly with `[router.policy-with-choose-one]`.
- Before a launch `Route<Self>` leaves the `Always` targets out (by the kind's default too), and
  all routes `Always` → `[router.all-routes-always]` (the router decides nothing) — for a model
  router that means at least one route needs an explicit `spawn: SpawnPolicy.OnDemand`.
- After `.toParallelAgents(…)` a code router's `route()` returns a list of the `OnDemand` targets
  to launch: `readonly Route<Self>[]` with an `Always` route, a non-empty
  `readonly [Route<Self>, ...Route<Self>[]]` without one — so `return []` compiles only with an
  `Always` route (the generated `RouterAnswers` table). At run time the framework launches the
  `Always` targets and what `route()` returns; how a model router decides its `OnDemand` routes —
  one call, a yes/no per route — is in [Routing patterns](Advanced-Routing#6-a-router-decides-who-is-launched).

## Errors

A router's step fails in two ways (#280 S19), both caught by `.onError(…)` right after the router:

| Error | Code | When |
| --- | --- | --- |
| `RouterFailedError` | `step.router` | `route()` threw, or a model router's model call failed — the original error is its `cause` |
| `RouterDecisionError` | `step.router.invalid-decision` | the answer is not allowed: a target outside `routes` (a cast), a list after `.chooseOne(…)`, an unknown or unreadable answer from the model — never retried |

Both carry `component` (`{ name }`), `nodeId` and `visitNumber`; `RouterDecisionError` is a
`RouterFailedError` (its `reason` says what was wrong), so `.onError(RouterFailedError, …)` takes
both. Matching goes through the cause chain: `.onError(CreditServiceUnavailableError, …)` takes the
service's failure inside `RouterFailedError`, as in the credit flow above. A limit
(`LimitExceededError`), a cancel or a pause thrown inside `route()` passes as it is, never wrapped.

## The router engine

A `RouterEngine` (root entry) picks one option for a text:

<!-- snippet-context
import type { MessageContent } from "@langchain/core/messages";
import type { UsageRecord } from "agboss";
-->

```ts
interface RouterEngine {
  readonly name: string;
  readonly route: (request: RouteRequest) => Promise<RouteOutcome>;
}
interface RouteRequest {
  readonly input: MessageContent;
  readonly options: readonly { readonly name: string; readonly description: string }[];
  readonly instructions?: string;
}
type RouteOutcome =
  | { kind: "decided"; decision: { next: string; reason: string; confidence?: number }; usage?: UsageRecord }
  | { kind: "failed"; reason: string; usage?: UsageRecord; unknownOption?: string; cause?: unknown };
```

| Kind  | How it decides                                                  | Cost source          |
| ----- | ------------------------------------------------------------------- | --------------------- |
| `jev` | OpenRouter Decisions API, a `choice` question, probabilities    | reported by the API  |
| `llm` | a chat model replies with the option, validated                 | tokens × price table |

Failures (HTTP error, malformed output, unknown option) are `failed` outcomes, never exceptions; a
failed call keeps its error as `cause` (the flow turns it into `RouterFailedError`, the other
failures into `RouterDecisionError`). One
option → `decided` without a model call; no options → `failed` without a call (`usage` absent).
Routers default to Jev — see [ADR-0001](ADR-0001-Jev-default-router).

Components use an engine for cheap decisions of their own through the `ROUTER_FACTORY` token —
job-scout's fit judge:

<!-- snippet-context
const FIT_QUESTION = "Does the job fit what the candidate wants?";
-->

```ts
import { Injectable, ROUTER_FACTORY, type RouterEngine } from "agboss";

@Injectable({ deps: [ROUTER_FACTORY] })
export class JobFitJudge {
  private readonly router: RouterEngine;

  constructor(routers: (name: string) => RouterEngine) {
    this.router = routers("job-fit"); // the model is defaults.router
  }

  async fits(profile: string, job: string): Promise<boolean> {
    const outcome = await this.router.route({
      instructions: FIT_QUESTION,
      input: `Candidate wants:\n${profile}\n\nJob:\n${job}`,
      options: [
        { name: "fit", description: "The job fits" },
        { name: "no_fit", description: "The job does not fit" },
      ],
    });
    return outcome.kind === "decided" && outcome.decision.next === "fit";
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
import { Agent, DecidedBy, Router, Workflow, WorkflowFinish, WorkflowStart, route, start } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
@WorkflowStart({ name: "desk-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class DeskStart {}
@WorkflowFinish({ name: "desk-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class DeskFinish {}
@Agent({ name: "support-agent", description: "Helps", prompt: "Help.", model: "moonshotai/kimi-k2.6" })
export class SupportAgent {}
@Agent({ name: "fallback-agent", description: "Anything else", prompt: "Answer.", model: "moonshotai/kimi-k2.6" })
export class FallbackAgent {}
@Router({ name: "desk-router", description: "Routes", decidedBy: DecidedBy.Model, prompt: "Pick who handles it.", model: "typesafe/jev-1.13", input: { message: WorkflowStartTextDto }, routes: [{ prompt: "Support", target: SupportAgent }, { prompt: "Anything else", target: FallbackAgent }] })
export class DeskRouter {}
@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  flow: [
    start(DeskStart)
      .returns(WorkflowStartTextDto)
      .toRouter(DeskRouter)
      .chooseOne(
        route(SupportAgent)
          .toFinish(DeskFinish),
        route(FallbackAgent)
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
import { replyWith, routeTo, testWith } from "agboss/testing";
import { Application, EmptyEnvironment } from "agboss";

@Application({ name: "desk-application", version: "1.0.0", environment: EmptyEnvironment, workflows: [Desk] })
class DeskApplication {}

const test = testWith(DeskApplication); // an application, never the workflow itself

test("help goes to support", async ({ app, mockLlm }) => {
  mockLlm(DeskRouter).thenAnswer((request) =>
    request.kind === "decision" && request.input.toString().includes("help")
      ? routeTo(SupportAgent)
      : routeTo(FallbackAgent),
  );
  mockLlm(SupportAgent).thenReturn(replyWith("On it."));

  const result = await app.execute(DeskStart, { text: "help" });

  expect(result).toFollowPath([DeskStart, DeskRouter, SupportAgent, DeskFinish]);
});
```

`app.router(DeskRouter).routeTo("…")` (the `app` fixture) asks one router alone with its scripted
model.

A code router calls no model, so there is nothing to script — `mockLlm(CreditLimitRouter)` throws
and says so. Replace the services its `route()` uses instead:

<!-- snippet-context
import { CreditService, CreditServiceUnavailableError, OrderHeldWorkflowFinish, OrderWorkflowStart } from "./credit.parts.js";
import { CreditLimitRouter } from "./credit-limit.router.js";
import { CreditWorkflow } from "./credit.workflow.js";
-->

```ts
import { expect } from "vitest";
import { testWith } from "agboss/testing";
import { Application, EmptyEnvironment } from "agboss";

@Application({ name: "credit-application", version: "1.0.0", environment: EmptyEnvironment, workflows: [CreditWorkflow] })
class CreditApplication {}

const test = testWith(CreditApplication); // an application, never the workflow itself

test("the credit service down holds the order", async ({ app, mockOf }) => {
  mockOf(CreditService).limitOf.mockRejectedValue(new CreditServiceUnavailableError("down"));

  const result = await app.execute(OrderWorkflowStart, { customerId: "c-1", total: 50 });

  expect(result).toFollowPath([OrderWorkflowStart, CreditLimitRouter, OrderHeldWorkflowFinish]);
});
```
