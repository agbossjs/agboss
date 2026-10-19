# Parallel — quorums, groups and arbiters

A parallel launch (#273, [Workflow → Parallel launches](Workflow#parallel-launches)) waits for every
branch with `.join()`. Often not every answer is needed: two scores out of three are enough, the
first five checked companies are enough, or one of several known combinations of reviewers decides
the case. A **quorum** (#279) says how many answers are enough, how long to wait, which answers
count and — with groups — which combination wins and where the execution goes next.

> **Status.** #279 PR 1 (the grammar, `@Arbiter` / `@OnAnswer`, the analyser, the generated
> types) and PR 2 (quorums at run time: counting, cancelling the rest, the deadline on the `Clock`,
> `QuorumNotReachedError`, `ArbiterError`, traces and `onQuorumDecided`, `agboss generate arbiter`).
> A runnable example: `examples/flow-patterns/src/panel`.

## Writing it

<!-- snippet-context
import { Agent, Arbiter, DecidedBy, OnAnswer, Workflow, WorkflowFinish, WorkflowStart, anyOf, group, start } from "agboss";
import { Integer, Text, listOf, optional } from "agboss/dto";
import { minutes, seconds } from "agboss/units";

export class CandidateDto {
  @Text({ prompt: "the candidate" })
  name!: string;
}
export class ScoreDto {
  @Integer({ prompt: "the score, 1–10" })
  score!: number;
}
export class ScoreReviewDto {
  @Text({ prompt: "the review" })
  text!: string;
}
export class LegalReviewDto {
  @Text({ prompt: "the legal risks" })
  risks!: string;
}
export class CritiqueDto {
  @Text({ prompt: "an objection" })
  objection!: string;
}
export class FastScreenDto {
  @Text({ prompt: "why the deal is rejected" })
  reason!: string;
}
export class DealReportDto {
  @Text({ prompt: "the report" })
  text!: string;
}
@WorkflowStart({ name: "candidate-workflow-start", description: "A candidate", input: CandidateDto })
export class CandidateWorkflowStart {}
@Agent({ name: "score-a-agent", description: "Scores skills", prompt: "Score.", model: "moonshotai/kimi-k2.6", input: { candidate: CandidateDto }, output: ScoreDto })
export class ScoreAAgent {}
@Agent({ name: "score-b-agent", description: "Scores risks", prompt: "Score.", model: "moonshotai/kimi-k2.6", input: { candidate: CandidateDto }, output: ScoreDto })
export class ScoreBAgent {}
@Agent({ name: "score-c-agent", description: "Scores the hire", prompt: "Score.", model: "moonshotai/kimi-k2.6", input: { candidate: CandidateDto }, output: ScoreDto })
export class ScoreCAgent {}
@Agent({ name: "score-summary-agent", description: "Sums up", prompt: "Sum up.", model: "moonshotai/kimi-k2.6", input: { candidate: CandidateDto, scores: listOf(ScoreDto) }, output: ScoreReviewDto })
export class ScoreSummaryAgent {}
@WorkflowFinish({ name: "score-review-workflow-finish", description: "The review", output: ScoreReviewDto })
export class ScoreReviewWorkflowFinish {}
@WorkflowStart({ name: "deal-workflow-start", description: "A deal", input: CandidateDto })
export class DealWorkflowStart {}
@Agent({ name: "legal-agent", description: "Legal review", prompt: "Review.", model: "moonshotai/kimi-k2.6", input: { deal: CandidateDto }, output: LegalReviewDto })
export class LegalAgent {}
@Agent({ name: "critic-agent", description: "Objects", prompt: "Object.", model: "moonshotai/kimi-k2.6", input: { deal: CandidateDto }, output: CritiqueDto })
export class CriticAgent {}
@Agent({ name: "fast-screen-agent", description: "Screens", prompt: "Screen.", model: "moonshotai/kimi-k2.6", input: { deal: CandidateDto }, output: FastScreenDto })
export class FastScreenAgent {}
@Agent({ name: "full-review-agent", description: "Reports", prompt: "Report.", model: "moonshotai/kimi-k2.6", input: { legal: optional(LegalReviewDto), critiques: listOf(CritiqueDto) }, output: DealReportDto })
export class FullReviewAgent {}
@WorkflowFinish({ name: "deal-report-workflow-finish", description: "The report", output: DealReportDto })
export class DealReportWorkflowFinish {}
@WorkflowFinish({ name: "quick-reject-workflow-finish", description: "Rejected at once", output: FastScreenDto })
export class QuickRejectWorkflowFinish {}
// @snippet
@Workflow({ name: "quorum-workflow", version: "1.0.0", flow: quorumPaths })
export class QuorumWorkflow {}
-->

```ts
// arbiters/in-range.arbiter.ts — by code: one @OnAnswer(Agent) method per agent of the launch
@Arbiter({ name: "in-range-arbiter", decidedBy: DecidedBy.Code })
export class InRangeArbiter {
  @OnAnswer(ScoreAAgent)
  fromScoreA(answer: ScoreDto): boolean {
    return this.isInRange(answer);
  }

  @OnAnswer(ScoreBAgent)
  fromScoreB(answer: ScoreDto): boolean {
    return this.isInRange(answer);
  }

  @OnAnswer(ScoreCAgent)
  fromScoreC(answer: ScoreDto): boolean {
    return this.isInRange(answer);
  }

  private isInRange(answer: ScoreDto): boolean {
    return answer.score >= 1 && answer.score <= 10;
  }
}

// arbiters/valid-score.arbiter.ts — by model: a criterion for every agent of the launch
@Arbiter({
  name: "valid-score-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count an answer only if it meets the criterion of the agent that gave it.",
  criteria: [
    { agent: ScoreAAgent, prompt: "Gives a 1–10 score for technical skills, with a reason" },
    { agent: ScoreBAgent, prompt: "Names at least two concrete risks" },
    { agent: ScoreCAgent, prompt: "Ends with a clear hire / no hire" },
  ],
})
export class ValidScoreArbiter {}

export const quorumPaths = [
  // any two of three: the counted answers only, the third cancelled
  start(CandidateWorkflowStart)
    .returns(CandidateDto)
    .toParallelAgents(ScoreAAgent, ScoreBAgent, ScoreCAgent)
    .acceptedBy(anyOf(InRangeArbiter, ValidScoreArbiter)) // the model only when the code rejects
    .joinQuorum({ min: 2, max: 3, deadline: seconds(30) })
    .returns(listOf(ScoreDto))
    .toAgent(ScoreSummaryAgent)
    .returns(ScoreReviewDto)
    .toFinish(ScoreReviewWorkflowFinish),

  // groups: the first complete one (by priority) continues its own path
  start(DealWorkflowStart)
    .returns(CandidateDto)
    .toParallelAgents(LegalAgent, CriticAgent, CriticAgent, FastScreenAgent)
    .joinQuorumGroups(
      group(LegalAgent, CriticAgent)
        .priority(1)
        .returns(LegalReviewDto)
        .returns(listOf(CritiqueDto)) // critic-agent is launched twice: a list, even of one
        .toAgent(FullReviewAgent)
        .returns(DealReportDto)
        .toFinish(DealReportWorkflowFinish),
      group(FastScreenAgent)
        .priority(2)
        .returns(FastScreenDto)
        .toFinish(QuickRejectWorkflowFinish),
      { deadline: minutes(1) },
    ),
] as const;
```

## The forms

| Form | Meaning |
| --- | --- |
| `.joinQuorum({ min })` | `max` defaults to `min`: after `min` counted answers go on, cancel the rest |
| `min` | how many **counted** answers are enough to go on |
| `max` | after how many counted answers to stop waiting and cancel the rest |
| `deadline` | how long the join waits — `seconds()`, `minutes()`, `hours()` (`agboss/units`), never a bare number |
| `.joinQuorumGroups(group(…).priority(n)<path>, …, { deadline })` | go on when a group is complete, along **that group's own path**; `min` / `max` do not apply |
| `.acceptedBy(X)` | an arbiter every answer passes before it counts — between the launch and the quorum |
| `.acceptedBy(X).acceptedBy(Y)` | the only AND: in path order, the first rejection stops the chain |
| `.acceptedBy(anyOf(X, Y))` | tried in order, the first that accepts accepts (S57) — the cheap code arbiter first |

Options are always an object: `.joinQuorum(2)` does not compile and the untyped builder refuses it.
`.acceptedBy(…).join()` does not compile; nothing follows `.joinQuorumGroups(…)` but
`.onJoinError(E, <side path>)`. A quorum follows `.toParallelAgents(…)` only — arbiters judge
agents' answers.

## Groups

- A group is `group(A, B, …)`; a repeated agent in it means "any of its copies", written n times n
  copies are needed. It is complete when **all** its places are counted.
- `.priority(n)` right after `group(…)`: **1 is the highest**; equal numbers (or none) are equal
  groups — the first complete one wins.
- Every group continues its own path: `group(…).priority(n).returns(…).toAgent / .toAction /
  .toRouter / .toWorkflow / .toFinish(…)`; a group without a continuation does not compile (and is
  `[graph.dead-end]` for the untyped builder). A node reached from two groups (or a group and a
  route, or `.onJoinError`) has its own path, by the general rules — `agent(FullReviewAgent)…`.
  `.joinQuorumGroups` counts as one nesting level (`[flow.path-too-deep]`).

## What `.returns(…)` may promise

The counted answers enter the [path scope](Path-scope#quorums) as the values the join's `.returns(…)`
names; the shape comes from **the launch**, not from the group:

| After | A single agent's value | A repeated class, or several agents with one `output` |
| --- | --- | --- |
| `.join()` | required `XDto` (`optional` for an `OnDemand` / `Skip` route) | `listOf(XDto)` |
| `.joinQuorum({ min })`, `min` = agents launched | required `XDto` | `listOf(XDto)` |
| `.joinQuorum({ min })`, any other `min` | `optional(XDto)` | `listOf(XDto)` |
| `group(A, B…)` of `.joinQuorumGroups(…)` | required `XDto` (the group's agents only) | `listOf(XDto)`, even when the group counts one copy |

The typed builder checks it against the generated `JoinOutputs`: a quorum's singles are the launch's
entry made optional unless `min` is the number of agents (one check, `Min extends Count`), and each
group has an entry of its own, keyed `<launch> group(<agents as listed>)`. `agboss check` checks it
again on the quorum itself — a required `XDto` after `.joinQuorum({ min: 2 })` of three agents is

```text
[flow.quorum-return-not-optional] fit-review-workflow-start → toParallelAgents(skills-score-agent,
culture-score-agent, salary-fit-agent): .joinQuorum({ min: 2 }) may leave skills-score-agent out of
the quorum — write .returns(optional(SkillsScoreDto)), not .returns(SkillsScoreDto) (or min: 3 to
count every agent)
```

## Arbiters

`@Arbiter` (`arbiters/<name>.arbiter.ts`, a `name` ending with `-arbiter`) decides **whether an
arriving answer counts** — once per answer; it is not a router and never chooses where to go. How it
decides is declared with `decidedBy`; nothing is inferred from its members:

- `DecidedBy.Model` — `model`, `prompt` (how to judge) and `criteria: [{ agent, prompt }]`, one per
  agent of the launch; the `prompt` never stands in for a missing criterion — an agent whose answers
  need no real check gets an explicit one ("Any non-empty answer").
- `DecidedBy.Code` — one `@OnAnswer(Agent) from<Agent>(answer: XDto): boolean` (or
  `Promise<boolean>`) method per agent class; the answer is the plain DTO, which copy or item it is
  comes from `executionContext.step.copyNumber` / `.itemIndex` (`deps: [ExecutionContext]`). The
  decorator checks the method: a wrong answer type, a return type other than `boolean` or a second
  required parameter does not compile. A rule shared by several agents is a private method each one
  calls; `@OnAnswer` takes exactly one class.

The other strategy's options do not compile (`criteria` on a code arbiter, `deps` on a model one).
A criterion or a method applies to every copy of a repeated agent and every item of a per-item
launch.

## Rules

| Code | |
| --- | --- |
| `[flow.quorum-impossible]` | `min` above the agents launched (per item: above `maxItems`); a group listing an agent the launch does not run, or more copies than it runs |
| `[flow.quorum-return-not-optional]` | a required `XDto` after `.joinQuorum({ min })` that may leave its agent out |
| `[flow.returns-mismatch]` | a quorum's or a group's `.returns(…)` names something else than its counted answers give |
| `[input.missing-on-path]` | a required field whose producer may be left out — the message names the agent and the fix `optional(…)` / `listOf(…)` |
| `[arbiter.not-an-arbiter]` | `.acceptedBy(X)` of a class without `@Arbiter` |
| `[arbiter.unhandled-agent]` | an agent of the launch without a criterion / an `@OnAnswer` method |
| `[arbiter.unknown-agent]` | a criterion / method for an agent the launch does not run |
| `[arbiter.duplicate-agent]` | two criteria / methods for one agent class |
| `[arbiter.answer-method-on-model]` | `@OnAnswer` on a `DecidedBy.Model` arbiter |
| `[arbiter.method-name]` | the method judging `CompanyCheckAgent` is not named `fromCompanyCheck` |
| `[name.kind-suffix]` | an arbiter's `name` without `-arbiter` |

## Describe

`agboss describe` prints the quorum as written (`.acceptedBy(anyOf(…))`, `.joinQuorum({ min: 2,
max: 3, deadline: seconds(30) })`, each group) and, for a list a quorum counts, each producer's
counts: `full-review-agent ← deal: deal-workflow-start, legal: legal-agent (optional), critiques:
critic-agent ×1–2` — a group counts at least the copies it lists and at most those launched, a
`.joinQuorum(…)` from none to all.

## At run time

A quorum is decided inside its launch's superstep (S26), as answers arrive — never by waiting for
every branch and deciding at the join:

1. Each branch runs its agent and then its **arbiter chain** under one `maxConcurrency` slot and in
   its own step frame (a code arbiter's `executionContext.step` is the branch's: `copyNumber`,
   `itemIndex`). The `.acceptedBy(…)` steps are an AND in path order — the first rejection stops the
   chain, later arbiters are not called; inside `anyOf(A, B)` the arbiters run in order and the first
   that accepts accepts.
2. The answer is recorded at once, synchronously after its chain: **`BranchVerdict.Counted`** with a
   monotonic `acceptedSequence` while places are left, **`Rejected`** (with `rejectedBy`: the
   arbiters that said no — every one of an `anyOf`), **`Surplus`** when it was accepted after the
   quorum was already decided.
3. Once the outcome is fixed — `max` answers counted (`max` defaults to `min`), a group has won (no
   higher-priority group can still complete), `min` or every group can no longer be reached, every
   branch is through, or the deadline passed — the launch is aborted: the branches still running or
   waiting for a slot end **`BranchStatus.Cancelled`**; a code check still running is abandoned, a
   model check's call (which cannot be stopped) is awaited for its cost; neither counts.
4. The **join** decides from the branch records only: the counted answers in counting order
   (`acceptedSequence` — never listed or finish order) go into the path scope; for groups the winning
   group's agents' answers, on that group's own path. Not reached → **`QuorumNotReachedError`**
   (`step.quorum`, a `StepFailedError` naming the launching step, with `min` and `counted`) into
   `.onJoinError(QuorumNotReachedError, …)`, else the execution fails with it.

| What happens in a branch | Its record |
| --- | --- |
| its answer counted | `Finished`, `Counted`, `acceptedSequence` |
| an arbiter rejected it | `Finished`, `Rejected`, `rejectedBy` |
| accepted after the quorum was decided | `Finished`, `Surplus` |
| still running (or checked) when the quorum was decided | `Cancelled` |
| its own step failed (`StepFailedError`) | `Skipped` — under a quorum it only leaves its place empty |
| an arbiter threw, returned no boolean, or its model did not answer | `Failed` with `ArbiterError` (`step.arbiter`): the launch fails, `.onJoinError(ArbiterError, …)` takes it |
| a limit, `app.cancel` | as for every launch (#273 S21): the launch fails / the execution is cancelled |

Every branch's spend counts — a cancelled or surplus branch's too.

### The deadline

`deadline` (`seconds()`, `minutes()`, `hours()`) is turned into `deadlineAt` once, when the launch is
dispatched, from the application's `Clock`, and kept in the launch's ticket (the state and every
branch's payload). A `Clock` sleep ends the quorum at that moment: `min` reached → go on (groups: the
highest-priority complete group), else `QuorumNotReachedError` ("the deadline passed"). A pause
counts as elapsed time. The time its branches wait in the tree's queue (#264
`maxConcurrentExecutions`) does not: the deadline moves by it, in the process that runs the launch
([FinOps → Concurrency of a tree](FinOps#concurrency-of-a-tree-264)); a model call's wait for a
provider's rate limit (#266) is not excluded. A `QuorumNotReachedError` past the moved deadline says so: `the deadline passed
(2026-01-05T09:01:10.000Z: the ticket's deadline plus 40 s in the tree's queue)`. The time in the queue
is kept by the process that runs the launch only: after a resume or a crash the next pass starts it
again from 0, so an already-passed ticket deadline cancels the unfinished branches at once. Tests move it with the `VirtualClock`
(`await clock.advance(seconds(31))`, [Testing → The clock](Testing#the-clock)).

### Pause, resume, recovery

A branch may pause inside a quorum (an approval); its siblings finish in the same superstep and their
records stay in the checkpoint's pending writes. On `resume` — or when another instance recovers the
execution after a crash ([Several instances](Several-instances)) — the quorum is rebuilt from those
records (counts, `max(acceptedSequence)`, verdicts), so only the unfinished branches run and counting
goes on where it stopped. If `deadlineAt` has passed by then, the unfinished branches are cancelled
without running and the join decides from the records.

### Model arbiters

A `DecidedBy.Model` arbiter makes one decision per answer, on its own `model`: a decision model gets
one `Decision.noul` — the agent's criterion — over the arbiter's `prompt` and the answer as JSON; a
chat model answers through one answer tool (`answer-arbiter`) with a boolean. P(yes) > 0.5 counts.
Its spend is recorded under `arbiter:<name>`; the execution's budgets are checked before every call.
The arbiter's prompt and criteria are part of the workflow's prompt version, its model of the model
version, and its model is a model use like a router's (`arbiters.<name>` in `agboss describe` and
`agboss check --models`). A code arbiter is created by the application's container at start.

### What it shows

`result.launches` adds, per quorum launch, `isQuorumReached`, `group` (the winning group's `agents`
and `priority`) and, per branch, `verdict`, `acceptedSequence` and `rejectedBy`. The branch's trace
entry carries the same; the join adds a trace entry "quorum decided" and the observer event
`onQuorumDecided` ([Observability](Observability#quorums)).

### `agboss generate arbiter`

`agboss generate arbiter in-range --workflow src/panel/panel.workflow.ts` writes
`arbiters/in-range.arbiter.ts`: a code arbiter with one `@OnAnswer(Agent) from<Agent>(answer:
ArbiterAnswerOf<typeof Agent>): boolean` method per distinct agent of the flow's launch (`--agent
<name>` picks the launch when there are several). It is not put into the flow — attach it with
`.acceptedBy(InRangeArbiter)` where it belongs.
