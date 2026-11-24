# Parallel — quorums, groups and arbiters

A parallel launch (#273, [Workflow → Parallel launches](Workflow#parallel-launches)) waits for every
branch with `.join()`. Often not every answer is needed: two scores out of three are enough, the
first five checked companies are enough, or one of several known combinations of reviewers decides
the case. A **quorum** (#279) says how many answers are enough, how long to wait, which answers
count and — with groups — which combination wins and where the execution goes next.

> **Status.** #279 PR 1 (the grammar, `@Arbiter` / `@Arbitrate`, the analyser, the generated
> types) and PR 2 (quorums at run time: counting, cancelling the rest, the deadline on the `Clock`,
> `QuorumNotReachedError`, `ArbiterError`, traces and `onQuorumDecided`, `agboss generate arbiter`).
> A runnable example: `examples/flow-patterns/src/panel`.

> **A failed join's undo (#340).** When a launch fails, the join first undoes its finished
> branches that declare `@Action({ compensateWith })`, newest first, before `.onError` runs or
> the branch's error fails the execution (`CompensationReason.JoinFailed`) — the join's values never
> reach the side path, so no path could undo them. Quorums launch agents only: nothing of theirs is
> undone. [Rollback → A failed join undoes its finished branches](Rollback#a-failed-join-undoes-its-finished-branches).

## Writing it

<!-- snippet-context
import { Agent, Arbiter, Arbitrate, Workflow, WorkflowFinish, WorkflowStart, onStart, toAgent, toFinish } from "@agboss/core";
import { Integer, Text, listOf, optional } from "@agboss/core/dto";
import { minutes, seconds } from "@agboss/core/units";

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
// arbiters/in-range.arbiter.ts — by code: one @Arbitrate(…targets) method per target of the launch
@Arbiter({ name: "in-range-arbiter" })
export class InRangeArbiter {
  @Arbitrate(ScoreAAgent)
  fromScoreA(answer: ScoreDto): boolean {
    return this.isInRange(answer);
  }

  @Arbitrate(ScoreBAgent)
  fromScoreB(answer: ScoreDto): boolean {
    return this.isInRange(answer);
  }

  @Arbitrate(ScoreCAgent)
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
  model: "typesafe/jev-1.13",
  prompt: inline("Count an answer only if it meets the criterion of the agent that gave it."),
  criteria: [
    { target: ScoreAAgent, prompt: "Gives a 1–10 score for technical skills, with a reason" },
    { target: ScoreBAgent, prompt: "Names at least two concrete risks" },
    { target: ScoreCAgent, prompt: "Ends with a clear hire / no hire" },
  ],
})
export class ValidScoreArbiter {}

export const quorumPaths = [
  // any two of three: the counted answers only, the third cancelled
  onStart(CandidateWorkflowStart)
    .inParallel([toAgent(ScoreAAgent), toAgent(ScoreBAgent), toAgent(ScoreCAgent)])
    .arbitratedBy(ValidScoreArbiter) // one arbiter; a hybrid one asks its own model only where its code cannot decide
    .joinQuorum({ min: 2, max: 3, deadline: seconds(30) })
    .toAgent(ScoreSummaryAgent)
    .toFinish(ScoreReviewWorkflowFinish),

  // groups: the first complete one (by priority) continues its own path
  onStart(DealWorkflowStart)
    .inParallel([
      toAgent(LegalAgent),
      toAgent(CriticAgent),
      toAgent(CriticAgent),
      toAgent(FastScreenAgent),
    ])
    .joinQuorumGroups({ deadline: minutes(1) })
    .onGroup(
      [LegalAgent, CriticAgent], // critic-agent is launched twice: a list, even of one
      { priority: 1 },
      toAgent(FullReviewAgent)
        .toFinish(DealReportWorkflowFinish),
    )
    .onGroup([FastScreenAgent], { priority: 2 }, toFinish(QuickRejectWorkflowFinish)),
] as const;
```

## The forms

| Form | Meaning |
| --- | --- |
| `.joinQuorum({ min })` | `max` defaults to `min`: after `min` counted answers go on, cancel the rest |
| `min` | how many **counted** answers are enough to go on |
| `max` | after how many counted answers to stop waiting and cancel the rest |
| `deadline` | how long the join waits — `seconds()`, `minutes()`, `hours()` (`@agboss/core/units`), never a bare number |
| `.joinQuorumGroups({ deadline })` + `.onGroup([targets], { priority }?, subPath)` | go on when a group is complete, along **that group's own path**; `min` / `max` do not apply |
| `.arbitratedBy(X)` | the one arbiter every answer passes before it counts — between the launch and the quorum; once per launch (no `anyOf`, no and / or of arbiters: the rule, and how it escalates from code to a model, lives in the class — `ArbiterModel`) |

Options are always an object: `.joinQuorum(2)` does not compile and the untyped builder refuses it.
`.arbitratedBy(…).join()` does not compile; nothing follows `.joinQuorumGroups(…)` but its
`.onError(E, <side path>)` — written **right after the join, before the first `.onGroup(…)`**, never after
one — and its `.onGroup(…)`s: the join is not a path until it has at least one. A quorum follows `.inParallel([…])`, `.forEachItem(…)` (`.joinQuorum(…)`
only: every item runs one target, so there are no groups) and `.toParallelAgents(…)`.

## Groups

- A group is `.onGroup([A, B, …], …)`: the targets of the launch (`@Agent`, `@ExternalTask`, `@Action`,
  `@Workflow`, from any launch — `.inParallel([…])` included); a repeated target in it means "any of
  its copies", written n times n copies are needed. It is complete when **all** its places are counted.
- `{ priority: n }` (the optional second argument): **1 is the highest**; equal numbers (or none)
  are equal groups — the first complete one wins.
- Every group continues its own path, its last argument: `toAgent(…)` / `toAction(…)` / `toRouter(…)` /
  `toExternalTask(…)` / `toWorkflow(…)` / `toFinish(…)` / `inParallel([…])` / `forEachItem(…)` — the
  same starters as `.onError(E, …)`; a group without a continuation does not compile (and is
  `[graph.dead-end]` for the untyped builder, as is a join with no `.onGroup(…)`). An open undoable
  action is owed only on the path of the group that counted it. A node reached from two groups (or a group and a
  route, or `.onError`) has its own path, by the general rules — `onAgent(FullReviewAgent)…`.
  `.joinQuorumGroups` counts as one nesting level (`[flow.path-too-deep]`).

## What the counted answers give

The counted answers enter the [path scope](Path-scope#quorums) as the values the join gives, derived
from the branches (#1270); the shape comes from **the launch**, not from the group:

| After | A single agent's value | A repeated class, or several agents with one `output` |
| --- | --- | --- |
| `.join()` | required `XDto` (`optional` for an `OnDemand` / `Skip` route) | `listOf(XDto)` |
| `.joinQuorum({ min })`, `min` = agents launched | required `XDto` | `listOf(XDto)` |
| `.joinQuorum({ min })`, any other `min` | `optional(XDto)` | `listOf(XDto)` |
| `.onGroup([A, B…], …)` of `.joinQuorumGroups(…)` | required `XDto` (the group's targets only) | `listOf(XDto)`, even when the group counts one copy |

Nothing is written for them: a step that requires a single answer a quorum may leave out is

```text
[input.missing-on-path] skills-reader-agent.skills (SkillsScoreDto) is not produced on the path
fit-review-workflow-start → skills-reader-agent (skills-score-agent may be left out of the quorum) —
make it optional(SkillsScoreDto) or listOf(SkillsScoreDto)
```

## Expiry of a branch's pause (#945)

A branch whose pause expired ends `BranchStatus.Expired` (`step.pause-expired` in `result.launches`), not
`Cancelled` or `Skipped`. In a quorum it did not vote and is no failure whatever the `FailurePolicy`; the quorum's
deadline binds its pauses, so the tree wakes by itself at it, and `QuorumNotReachedError.expired` names the
branches that expired. In a plain `.join()` it follows the `FailurePolicy`: `Skip` drops it, `FailFast` fails the
launch with its `PauseExpiredError`; the `.onError(…)` side path reads the answers already settled as
`optional(…)` inputs (see [Pauses](Pauses#expiry-in-parallel-launches-945)).

## External tasks in a launch (#1306)

`toExternalTask(Task)` is a branch of `.inParallel([…])` and the step of `.forEachItem(…, { maxItems })`
like `toAgent`, `toAction` and `toWorkflow` — no `@Agent` wrapped around a person or a service just to
wait in parallel. Every branch is its own pause on its task's channel (`PendingPause.itemIndex` for the
item of a `.forEachItem`); `.onError(E, skip())` on the branch drops its failure from the join. A
quorum (`.joinQuorum(…)`, `.joinQuorumGroups(…)`) counts the answers the arbiter accepts: an
`@Arbitrate(LegalSignOffExternalTask, …)` method judges the task's output DTO, so `{ approved: false }` is
a valid answer and no vote. Once the quorum is decided — or it can no longer be reached — the pauses
still open are withdrawn (`PauseResolution.Withdrawn`), and a late answer to one fails with
`PauseClosedError`. The accepted answers go on as `listOf(AnswerDto)`, which a node below must read.

```text
onStart(ContractCommitteeWorkflowStart)
  .inParallel([toExternalTask(LegalSignOff), toExternalTask(SecuritySignOff), toExternalTask(FinanceDirector)])
  .arbitratedBy(SignOffArbiter)
  .joinQuorum({ min: 2, deadline: hours(2) })
  .onError(QuorumNotReachedError, toFinish(ContractRejectedWorkflowFinish))
  .toAction(SignContractAction)
  .toFinish(ContractSignedWorkflowFinish)
```

The runnable version is `examples/flow-patterns/src/committee/`. A text `@Agent` branch (no `output`) gives
its judge the reply as a `WorkflowFinishTextDto`, a `@Workflow` branch the output of its finishes.
A working-time `deadline` (`workDays(…)` with a `calendar`) is not available on a quorum yet.

## Arbiters

`@Arbiter` (`arbiters/<name>.arbiter.ts`, an optional kebab-case `name`) decides **whether an
arriving answer counts** — once per answer; it is not a router and never chooses where to go. How it
decides follows from what it declares:

- `criteria: [{ target, prompt }]` with `model` and `prompt` (how to judge) — a model arbiter, one
  criterion per target of the launch; the `prompt` never stands in for a missing criterion — a
  target whose answers need no real check gets an explicit one ("Any non-empty answer").
- `@Arbitrate(A, B, …) isMeaningful(answer: XDto): boolean` (or `Promise<boolean>`) — an arbiter of
  code (`$0`), one method for one or more targets (`@Agent`, `@ExternalTask`, `@Action`, `@Workflow`;
  the method name is yours); the answer is the target's output, `Metadata.createdBy(answer)` the
  target that gave it; which copy or item it is comes from `executionContext.step.copyNumber` /
  `.itemIndex` (`deps: [ExecutionContext]`). The decorator checks the method: a wrong answer type, a
  return type other than `boolean` or a second required parameter does not compile.
- `deps: [ArbiterModel]` (and an optional `model`) on a code arbiter — a hybrid: the code decides
  what it can at `$0` and asks its own model (`arbiterModel.decide(…)` / `.invoke(…)`) only where it
  must. Every call checks the execution's budgets first and is charged under `arbiter:<name>`, a
  failed call's partial spend too. `model` without `ArbiterModel` in `deps` does not compile.

`criteria` on an arbiter with `deps` does not compile. A criterion or a method applies to every copy
of a repeated target and every item of a per-item launch.

## Rules

| Code | |
| --- | --- |
| `[flow.quorum-impossible]` | `min` above the agents launched (per item: above `maxItems`); a group listing an agent the launch does not run, or more copies than it runs |
| `[launch.unjoinable-output]` | a branch's output no join value can carry (a list launched several times, a lone `oneOf`) |
| `[input.missing-on-path]` | a required field whose producer may be left out — the message names the agent and the fix `optional(…)` / `listOf(…)` |
| `[arbiter.not-an-arbiter]` | `.arbitratedBy(X)` of a class without `@Arbiter` |
| `[arbiter.unhandled-target]` | a target of the launch without a criterion / an `@Arbitrate` method |
| `[arbiter.unknown-target]` | a criterion / method for a target the launch does not run |
| `[arbiter.duplicate-target]` | two criteria / methods for one target class |
| `[arbiter.branch-has-no-output]` | a void `@Action` (no `output`) in a launch an arbiter judges |
| `[arbiter.model-without-arbiter-model]` | a code `@Arbiter` names `model` / `modelProvider` without `ArbiterModel` in `deps` |
| `[name.not-kebab-case]` | an arbiter's `name` is not kebab-case |

## Describe

`agboss describe` prints the quorum as written (`.arbitratedBy(…)`, `.joinQuorum({ min: 2,
max: 3, deadline: seconds(30) })`, each group) and, for a list a quorum counts, each producer's
counts: `full-review-agent ← deal: deal-workflow-start, legal: legal-agent (optional), critiques:
critic-agent ×1–2` — a group counts at least the copies it lists and at most those launched, a
`.joinQuorum(…)` from none to all.

## At run time

A quorum is decided inside its launch's superstep (S26), as answers arrive — never by waiting for
every branch and deciding at the join:

1. Each branch runs its target and then its **arbiter** under one `maxConcurrency` slot and in its own
   step frame (a code arbiter's `executionContext.step` is the branch's: `copyNumber`, `itemIndex`).
   A hybrid arbiter's model calls are checked against the budgets first and charged under
   `arbiter:<name>`, a failed call's spend kept; once the quorum is decided it asks no more.
2. The answer is recorded at once, synchronously after its check: **`BranchVerdict.Counted`** with a
   monotonic `acceptedSequence` while places are left, **`Rejected`** (with `rejectedBy`: the
   arbiter that said no), **`Surplus`** when it was accepted after the quorum was already decided.
3. Once the outcome is fixed — `max` answers counted (`max` defaults to `min`), a group has won (no
   higher-priority group can still complete), `min` or every group can no longer be reached, every
   branch is through, or the deadline passed — the launch is aborted: the branches still running or
   waiting for a slot end **`BranchStatus.Cancelled`**; a code check still running is abandoned, a
   model check's call (which cannot be stopped) is awaited for its cost; neither counts.
4. The **join** decides from the branch records only: the counted answers in counting order
   (`acceptedSequence` — never listed or finish order) go into the path scope; for groups the winning
   group's agents' answers, on that group's own path. Not reached → **`QuorumNotReachedError`**
   (`step.quorum`, a `StepFailedError` naming the launching step, with `min` and `counted`) into
   `.onError(QuorumNotReachedError, …)`, else the execution fails with it.

| What happens in a branch | Its record |
| --- | --- |
| its answer counted | `Finished`, `Counted`, `acceptedSequence` |
| an arbiter rejected it | `Finished`, `Rejected`, `rejectedBy` |
| accepted after the quorum was decided | `Finished`, `Surplus` |
| still running (or checked) when the quorum was decided | `Cancelled` |
| its own step failed (`StepFailedError`) | `Skipped` — under a quorum it only leaves its place empty |
| an arbiter threw, returned no boolean, or its model did not answer | `Failed` with `ArbiterError` (`step.arbiter`): the launch fails, `.onError(ArbiterError, …)` takes it |
| a limit, `app.cancel` | as for every launch (#273 S21): the launch fails / the execution is cancelled |
| a budget exhausted by any branch's call (#338) | its calls in flight aborted at once, `Failed` with `BudgetExceededError`: the launch fails before the quorum is decided, `.onError(BudgetExceededError, …)` takes it ([FinOps → At run time](FinOps#at-run-time)) |

Every branch's spend counts — a cancelled or surplus branch's too. Each branch's calls are counted
the moment they are made (#338), so an arbiter's check before its model call sees the siblings'
spend while they run.

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
again from 0, so an already-passed ticket deadline cancels the unfinished branches at once. Tests move it with the `VirtualClock`, in
steps shorter than the lease while the launch runs (three `await clock.advance(seconds(10))`, then
`seconds(1)`: one jump of 30 s or more freezes the holder past its lease, [Testing → The
clock](Testing#the-clock)).

### Pause, resume, recovery

A branch may pause inside a quorum (an approval); its siblings finish in the same superstep and their
records stay in the checkpoint's pending writes. On `resume` — or when another instance recovers the
execution after a crash ([Several instances](Several-instances)) — the quorum is rebuilt from those
records (counts, `max(acceptedSequence)`, verdicts), so only the unfinished branches run and counting
goes on where it stopped. If `deadlineAt` has passed by then, the unfinished branches are cancelled
without running and the join decides from the records.

A quorum decided while a branch waits for an answer (#337) — by its siblings' answers, a group that
won, the deadline, or found decided on restore — withdraws that branch's pending pauses
(`PauseResolution.Withdrawn`; its channel's `onPauseClosed` is told once, `reason: Withdrawn` — [Pauses → Telling the channel and the listeners](Pauses#telling-the-channel-and-the-listeners-940)):
the pass that decided it closes them before it ends, the waiting branch ends `BranchStatus.Cancelled`
and the join runs in the same call — nothing is left in `result.pending`. A deadline that passes
while the tree rests (no branch of it running) is acted on by the next pass: a resume or a recovery
finds the quorum decided, cancels the unfinished branches and withdraws their pauses.

> **TODO (#945, not on main yet):** a branch whose pause *expires* ends `BranchStatus.Expired`, counted
> by the quorum and the plain join like any other end; the settled answers and `joinFailed` are
> written here when #945 merges ([Pauses → Expiry in a quorum](Pauses#expiry-in-a-quorum)).

### Model arbiters

A `DecidedBy.Model` arbiter makes one decision per answer, on its own `model`: a decision model gets
one `Decision.boolean` — the agent's criterion — over the arbiter's `prompt` and the answer as JSON; a
chat model answers through one answer tool (`answer-arbiter`) with a boolean. P(yes) > 0.5 counts.
Its spend is recorded under `arbiter:<name>`; the execution's budgets are checked before every call.
The arbiter's prompt and criteria are part of the workflow's prompt version, its model of the model
version, and its model is a model use like a router's (`arbiters.<name>` in `agboss describe` and
`agboss check --models`). A code arbiter is created by the application's container at start.

### What it shows

`result.launches` adds, per quorum launch, `isQuorumReached`, `group` (the winning group's `targets`
and `priority`) and, per branch, `verdict`, `acceptedSequence` and `rejectedBy`. The branch's trace
entry carries the same; the join adds a trace entry "quorum decided" and the observer event
`onQuorumDecided` ([Observability](Observability#quorums)).

### `agboss generate arbiter`

`agboss generate arbiter in-range-arbiter --workflow panel-workflow` writes
`arbiters/in-range.arbiter.ts`: a code arbiter with one `@Arbitrate(A, B) isMeaningful(answer:
ArbitratedAnswerOf<[typeof A, typeof B]>): boolean` method for the distinct agents of the flow's launch (`--agent
<name>-agent` picks the launch when there are several). It is not put into the flow — attach it with
`.arbitratedBy(InRangeArbiter)` where it belongs.
