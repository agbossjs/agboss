# Workflows — the paths

A workflow is a `@Workflow` class whose `flow` is a list of **paths** (#272, [ADR-0019](ADR-0019-Flow-as-paths-with-path-scope)).
A path reads as a sentence — "the start returns the message → the router chooses → the profiler
returns a profile → …": it starts at a source, every transition names the kind of its target, and
what a step gives is written on the edge with `.returns(…)`. The paths hold the whole topology and
the data flow; components declare types only. The flow is checked when the workflow is assembled —
before any model call — and every violation is reported at once. Every block on this page compiles
against the current package, with the `.agboss/types.d.ts` its workflows generate
(`npm run check:docs`).

<!--
```ts file=chat.components.ts
import { Agent, DecidedBy, Router, WorkflowFinish, WorkflowStart } from "agboss";
import { Text, WorkflowStartTextDto, oneOf, optional } from "agboss/dto";

export class ProfileDto {
  @Text({ prompt: "the candidate's profile" })
  summary!: string;
}
export class ResumeMissingDto {
  @Text({ prompt: "why no resume was found", optional: true })
  reason?: string;
}
export class OpeningsDto {
  @Text({ prompt: "the openings found" })
  openings!: string;
}
@WorkflowStart({ name: "intake-workflow-start", description: "A customer's message", input: WorkflowStartTextDto })
export class IntakeWorkflowStart {}
@Agent({ name: "profiler-agent", description: "Reads the resume into a profile", prompt: "Read the resume.", model: "moonshotai/kimi-k2.6", input: { message: WorkflowStartTextDto }, output: oneOf(ProfileDto, ResumeMissingDto) })
export class ProfilerAgent {}
@Agent({ name: "scout-agent", description: "Finds openings for the profile", prompt: "Find openings.", model: "moonshotai/kimi-k2.6", input: { profile: optional(ProfileDto) }, output: OpeningsDto })
export class ScoutAgent {}
@WorkflowFinish({ name: "ask-resume-workflow-finish", description: "Asks for a resume", output: ResumeMissingDto })
export class AskResumeWorkflowFinish {}
@WorkflowFinish({ name: "chat-workflow-finish", description: "The openings found", output: OpeningsDto })
export class ChatWorkflowFinish {}
@WorkflowFinish({ name: "no-reply-workflow-finish", description: "Ends without a reply", output: WorkflowStartTextDto })
export class NoReplyWorkflowFinish {}
@Router({
  name: "main-router",
  description: "Sends the message to the step that handles it, or ends the execution",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick who handles the customer's message next.",
  input: { message: WorkflowStartTextDto },
  maxVisits: 3,
  routes: [
    { target: ProfilerAgent, prompt: "The customer sends or changes their resume" },
    { target: ScoutAgent, prompt: "The customer asks for job openings" },
    { target: NoReplyWorkflowFinish, prompt: "Stop without a reply: the message needs no answer" },
  ],
})
export class MainRouter {}
```
-->

## Writing a workflow

<!-- snippet-context
import { oneOf } from "agboss/dto";
import { AskResumeWorkflowFinish, ChatWorkflowFinish, IntakeWorkflowStart, MainRouter, NoReplyWorkflowFinish, OpeningsDto, ProfileDto, ProfilerAgent, ResumeMissingDto, ScoutAgent } from "./chat.components.js";
-->

```ts file=chat.workflow.ts
import { Workflow, WorkflowSettings, caseOf, route, router, start, type WorkflowDefinition } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { usd } from "agboss/units";

@Workflow({
  name: "chat-workflow",
  version: "1.0.0",
  flow: [
    // MainRouter is reached from the start and from the profiler → it is continued in its own path
    start(IntakeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(MainRouter),

    router(MainRouter)
      .chooseOne(
        route(ProfilerAgent)
          .returns(oneOf(ProfileDto, ResumeMissingDto)) // its output, then one case per variant
          .switch(
            caseOf(ProfileDto)
              .toRouter(MainRouter), // the loop is visible: back to the router
            caseOf(ResumeMissingDto)
              .toFinish(AskResumeWorkflowFinish),
          ),
        route(ScoutAgent)
          .returns(OpeningsDto)
          .toFinish(ChatWorkflowFinish),
        route(NoReplyWorkflowFinish),
      ),
  ],
  defaults: {
    models: { temperature: 0 },
    router: { model: "typesafe/jev-1.13" },
    history: { limit: 5 },
  },
  maxSteps: 8,
})
export class ChatWorkflow implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perRun: { cost: usd(0.05) }, perDay: { cost: usd(1) } })
      .build();
  }
}
```

The components behind it declare types only — what they read (`input`, by field) and what they
give (`output`); the router lists its targets with the text Jev chooses by:

```ts no-check: a fragment — the components are defined in the page's hidden components file
@Agent({
  name: "profiler-agent",
  description: "Reads the resume into a profile",
  prompt: "Read the resume.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: oneOf(ProfileDto, ResumeMissingDto), // answered through answer tools
})
export class ProfilerAgent {}

@Router({
  name: "main-router",
  description: "Sends the message to the step that handles it, or ends the execution",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick who handles the customer's message next.",
  input: { message: WorkflowStartTextDto }, // what the router decides on
  maxVisits: 3,
  routes: [
    { target: ProfilerAgent, prompt: "The customer sends or changes their resume" },
    { target: ScoutAgent, prompt: "The customer asks for job openings" },
    { target: NoReplyWorkflowFinish, prompt: "Stop without a reply: the message needs no answer" },
  ],
})
export class MainRouter {}
```

## The grammar

| Part | |
| --- | --- |
| A line is a path | it starts with its source — `start(S)`, or `agent(X)` / `router(R)` / `action(A)` for a node reached from two or more places — then goes on with steps. The kind of every source and target is checked by the compiler (`agent(MainRouter)` does not compile) |
| `.returns(…)` | `start(S).returns(InputDto)` — a start returns its input; after any other step, what the component's `output` gives — one value per `.returns`, several (a start's map of fields) as a chain `.returns(A).returns(optional(B))` in any order; none after a step without `output`. `{ about: T }` beside one class or a list says what the value is about ([Path scope](Path-scope)). Checked by the compiler against the generated types |
| Transitions | `.toAgent(X)`, `.toRouter(R)`, `.toAction(A)`, `.toFinish(F)` — each names its target's kind |
| A router's choice | `.toRouter(R).chooseOne(route(A)…, route(B)…, route(F))` (or `router(R).chooseOne(…)` in its own path): exactly the router's `routes` (`[router.routes-mismatch]`), each `route(…)` continued to its end. How to choose stays in `@Router({ routes: [{ target, prompt }] })` ([Routers](Routers)) |
| Branching by result | `.returns(oneOf(ADto, BDto)).switch(caseOf(ADto)…, caseOf(BDto)…)` after a step with a `oneOf` output — exhaustive (`[flow.switch-not-exhaustive]`, `[flow.switch-unknown-case]`); `caseOf(ADto, { about: T })` says what that variant is about, never `.returns(oneOf(…), { about })` |
| Errors | `.onError(ErrorClass, toAction(…)… \| toAgent(…)… \| toFinish(F))` right after the step that throws, before its `.returns(…)` — see [Rollback](Rollback) |
| One way in → inline | a node reached from one place is continued right there (also inside `route(…)`, `caseOf(…)` and `.onError(…)`); an own path for it → `[flow.single-entry-own-path]` |
| Two or more ways in → own path | a non-terminal node reached from several places is continued in its own path (`agent(ReviewerAgent)…`), every path into it ends at it; inline → `[flow.shared-node-inline]` |
| Finishes are terminal | `.toFinish(F)` / `route(F)` — always inline, from any number of places |
| One class = one node | a class mentioned again is the same node (loops, merges); two stages are two classes sharing an options const (`@Agent({ ...reviewerAgentOptions, name: "final-reviewer-agent" })`) — `[flow.continuation-twice]` |
| Position never carries meaning | paths, routes and cases can be reordered without changing the graph; only the order of steps inside a path is a sequence |
| One call per line | a path reads as its steps: `start(S)` / `.returns(…)` / `.toFinish(F)`, each call on its own line, `route(X)` / `.toFinish(F)` inside a choice too (#289). In the repo `*.workflow.ts` modules and the flow fixtures are formatted by `make fmt` (`node scripts/format-flows.mjs`) instead of Prettier and checked by ESLint (`@stylistic/newline-per-chained-call`, `ignoreChainWithDepth: 1`); the docs' flow snippets by `npm run check:docs`; `agboss create` / `agboss generate` write workflow modules this way |

## A node reached from two places

<!--
```ts file=offer.components.ts
import { Action, Agent, WorkflowFinish, WorkflowStart, type ActionHandler, type InputOf, type OutputOf } from "agboss";
import { Flag, Text, oneOf } from "agboss/dto";

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
@Agent({ name: "reviewer-agent", description: "Reviews the draft", prompt: "Review the draft.", model: "moonshotai/kimi-k2.6", input: { draft: OfferDraftDto }, output: oneOf(ChangesRequestedDto, DraftApprovedDto) })
export class ReviewerAgent {}
@Agent({ name: "editor-agent", description: "Rewrites the draft by the review notes", prompt: "Rewrite the draft.", model: "moonshotai/kimi-k2.6", input: { draft: OfferDraftDto, changes: ChangesRequestedDto }, output: OfferDraftDto, maxVisits: 2 })
export class EditorAgent {}
@Action({ name: "notify-recruiter-action", description: "Tells the recruiter the offer failed", input: { draft: OfferDraftDto } })
export class NotifyRecruiterAction implements ActionHandler<NotifyRecruiterAction> {
  async execute(input: InputOf<NotifyRecruiterAction>): Promise<void> {
    await Promise.resolve(input.draft.value.text);
  }
}
@Action({ name: "send-offer-action", description: "Sends the approved offer", input: { draft: OfferDraftDto }, output: OfferSentDto })
export class SendOfferAction implements ActionHandler<SendOfferAction> {
  execute(input: InputOf<SendOfferAction>): Promise<OutputOf<SendOfferAction>> {
    return Promise.resolve({ delivered: input.draft.value.text.length > 0 });
  }
}
@WorkflowFinish({ name: "offer-failed-workflow-finish", description: "No offer", output: OfferDraftDto })
export class OfferFailedWorkflowFinish {}
@WorkflowFinish({ name: "offer-sent-workflow-finish", description: "The offer was sent", output: OfferSentDto })
export class OfferSentWorkflowFinish {}
```
-->

<!-- snippet-context
import { Workflow, VisitsLimitExceededError, agent, caseOf, oneOf, start, toAction } from "agboss";
import { ChangesRequestedDto, DraftAgent, DraftApprovedDto, EditorAgent, NotifyRecruiterAction, OfferDraftDto, OfferFailedWorkflowFinish, OfferSentDto, OfferSentWorkflowFinish, OfferWorkflowStart, ReviewerAgent, SendOfferAction, ShortlistDto } from "./offer.components.js";
-->

```ts
@Workflow({
  name: "offer-workflow",
  version: "1.0.0",
  flow: [
    start(OfferWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(DraftAgent)
      .returns(OfferDraftDto)
      .toAgent(ReviewerAgent), // every path into the reviewer ends at it

    agent(ReviewerAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(
        caseOf(ChangesRequestedDto, { about: OfferDraftDto }) // the changes are about this draft
          .toAgent(EditorAgent) // maxVisits: 2 — the third edit is refused before its model call
          .onError(
            VisitsLimitExceededError,
            toAction(NotifyRecruiterAction)
              .toFinish(OfferFailedWorkflowFinish), // no output → no .returns
          )
          .returns(OfferDraftDto)
          .toAgent(ReviewerAgent),
        caseOf(DraftApprovedDto)
          .toAction(SendOfferAction)
          .returns(OfferSentDto)
          .toFinish(OfferSentWorkflowFinish),
      ),
  ],
})
export class OfferWorkflow {}
```

The limit of a loop sits on the node whose call would be wasted — here the editor, so the last
draft is the last reviewed one. A cycle needs `maxVisits` on at least one of its nodes, a router or
an agent (`[graph.cycle-without-max-visits]`).

## What a node reads: the path's scope

Every `.returns(…)` puts a value on the path — its **scope** ([Path scope](Path-scope)). A node's
`input` fields are filled from it by type (`draft: OfferDraftDto` reads the latest `OfferDraftDto`
on the path, from whoever produced it); a field no path brings fails assembly
(`[input.missing-on-path]`, naming the shortest path that lacks it), `optional(Dto)` may be absent.
An agent gets them in its **input message** — one block per field, `### draft (from editor-agent)`
and the value as JSON — after its instructions, so the system prompt stays the same between runs
and caches ([Agents](Agents)). An agent without `input` and `output` is a **text agent**: it reads
the message (`WorkflowStartTextDto`) and answers text, which only a `WorkflowFinishTextDto` finish
takes (`[flow.text-agent-target]`).

An **action** (`@Action`, code without a model) gets its fields, each as `{ value, producer }`
(`producer`: the class that gave it) — and nothing else; the execution it runs in comes through
`deps: [ExecutionContext]` ([Components](Components#the-execution-context)).

<!-- snippet-context
import { Action, Workflow, WorkflowFinish, WorkflowStart, start, type ActionHandler, type InputOf } from "agboss";
import { OfferDraftDto } from "./offer.components.js";
// @snippet
@WorkflowStart({ name: "audit-workflow-start", description: "A draft", input: OfferDraftDto })
export class AuditWorkflowStart {}
@WorkflowFinish({ name: "audited-workflow-finish", description: "Logged", output: OfferDraftDto })
export class AuditedWorkflowFinish {}
@Workflow({ name: "audit-workflow", version: "1.0.0", flow: [start(AuditWorkflowStart).returns(OfferDraftDto).toAction(AuditLogAction).toFinish(AuditedWorkflowFinish)] })
export class AuditWorkflow {}
-->

```ts
@Action({ name: "audit-log-action", description: "Writes the draft to the audit log", input: { draft: OfferDraftDto } })
export class AuditLogAction implements ActionHandler<AuditLogAction> {
  async execute(input: InputOf<AuditLogAction>): Promise<void> {
    await Promise.resolve(`${input.draft.producer.name}: ${input.draft.value.text}`);
  }
}
```

## Generated types

`agboss check --workflow src/app.workflow.ts` loads the workflows (transpile-only, a stale file
never blocks it) and writes `.agboss/types.d.ts`: the tables that type `.returns(…)` against each
component's `output`, `InputOf<X>` / `OutputOf<X>` of every node, and `app.execute(Start, input)` /
`result.output`. A class the types need must be exported (`[types.unexported-class]`); without the
file, `tsc` names the fix (`Missing generated types — run agboss check`). The file is git-ignored;
a generated project writes it on install (`npm run types`) and `agboss generate` refreshes it.

## Assembly rules

Checked by `workflowOf` / `createApp` / `agboss check` before any model call; all violations are
reported together in a `GraphRuleError` with stable codes: names end with their kind and are unique
in the application (`[name.kind-suffix]`, `[graph.duplicate-node-name]`); DTO classes on paths end
with `Dto` (`[dto.name]`); `.returns` matches the output (`[flow.returns-mismatch]`); every input is
on every path (`[input.missing-on-path]`); a router's choice lists its routes; the existing graph
rules — a workflow start exists, no unreachable node, no dead end, nothing after a finish, a cycle
has `maxVisits`. A path nested more than 4 levels deep is a warning (`[flow.path-too-deep]`), an
error under `--strict`.

## Testing

A workflow is tested end to end with scripted models — no network ([Testing](Testing)):

<!-- snippet-context
import { ChatWorkflow } from "./chat.workflow.js";
import { ChatWorkflowFinish, IntakeWorkflowStart, MainRouter, OpeningsDto, ScoutAgent } from "./chat.components.js";
-->

```ts
import { expect } from "vitest";
import { replyWith, routeTo, testWith } from "agboss/testing";
import { Application } from "agboss";

@Application({ name: "chat-application", version: "1.0.0", workflows: [ChatWorkflow] })
class ChatApplication {}

const test = testWith(ChatApplication); // an application, never the workflow itself

test("a question about openings goes to the scout", async ({ app, mockLlm }) => {
  mockLlm(MainRouter).thenReturn(routeTo(ScoutAgent));
  mockLlm(ScoutAgent).thenReturn(replyWith(OpeningsDto, { openings: "Backend at Acme" }));

  const result = await app.execute(IntakeWorkflowStart, { text: "any backend jobs?" });

  expect(result).toFollowPath([IntakeWorkflowStart, MainRouter, ScoutAgent, ChatWorkflowFinish]);
  expect(result).toFinishWith(ChatWorkflowFinish, { openings: "Backend at Acme" });
});
```

## Not in the core yet

Parallel launches and joins (`.toParallelAgents(…)`, `.join()`, quorums — #273), child workflows
(`.toWorkflow(…)` — #263) and code routers (`DecidedBy.Code` — #280) build on these paths. The old
flow DSL (`from(…).next(…)`, `chain`, `catchError`, `batchParallel`, `node`) is gone;
[ADR-0019](ADR-0019-Flow-as-paths-with-path-scope) says why.
