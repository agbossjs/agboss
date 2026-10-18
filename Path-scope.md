# Path scope — what a node reads

Every path carries a **scope**: the values its steps returned so far (#270, [ADR-0019](ADR-0019-Flow-as-paths-with-path-scope)).
Components declare what they read by type (`input: { draft: OfferDraftDto }`) and what they give
(`output: OfferDraftDto`); the flow writes on each edge what was given (`.returns(OfferDraftDto)`).
The same definition is used by the analyser at assembly, by the generated types and by the runtime.

## Slots and writes

- A **slot per shape**: `OfferDraftDto` and `listOf(OfferDraftDto)` are separate slots, and a
  `listOf(oneOf(ADto, BDto))` is one slot of the whole polymorphic list — it never fills a
  `listOf(ADto)` field (#299 S53: no filtered list drops the other variants; a step that hands on
  two separate lists returns two lists). A slot holds one value: the latest.
- Writes: a start's `.returns(…)` (its validated input), every `.returns(…)` after a step, and a
  `caseOf(…)` branch (the variant it matched). A `.returns(…)` names **one value**; a step that
  gives several — a start whose `input` is a map of fields — names them in a chain,
  `.returns(CompanyDto).returns(optional(SearchRequestDto))`, in any order. A `oneOf` output is
  written `.returns(oneOf(A, B))` and branched right after by `.switch(caseOf(A)…, caseOf(B)…)`.
  A write replaces the slot's value.
- In the checkpoint a slot is plain data — `{ slot, producer: "<name>", variant?: "<DtoClass>",
  value, builtFrom, about? }` — keyed by the DTO's class name, which is unique in the application
  (`[dto.duplicate-name]`); renaming a DTO class changes the workflow's config fingerprint.

## Reads

- A field `name: XDto` reads the slot's current value; `listOf(XDto)` reads the latest list;
  `optional(XDto)` may be absent. Two fields of one class would read the same value
  (`[flow.ambiguous-field]`): the earlier versions are read with `historyOf(XDto)`.
- Code (actions, finishes with `input`) gets each field as `Produced<T, P>` — `{ value, producer }`,
  `producer` the union of the classes the paths can bring; `isVariant(value, XDto)` narrows a
  `oneOf` value.
- An agent gets them in its **input message**, one block per field in declaration order:
  `### draft (from editor-agent)` and the value as JSON with sorted keys (`### after` and `none`
  for an absent `optional`). The instructions stay static — a field in the instructions as
  `{{input.…}}` fails assembly (`[prompt.input-in-instructions]`).

<!--
```ts file=history.components.ts
import { Agent, WorkflowFinish, WorkflowStart } from "agboss";
import { Text, historyOf, oneOf } from "agboss/dto";

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
@WorkflowStart({ name: "history-offer-workflow-start", description: "A shortlist", input: ShortlistDto })
export class HistoryOfferWorkflowStart {}
@Agent({ name: "first-draft-agent", description: "Drafts the offer", prompt: "Draft the offer.", model: "moonshotai/kimi-k2.6", input: { shortlist: ShortlistDto }, output: OfferDraftDto })
export class FirstDraftAgent {}
@Agent({ name: "draft-editor-agent", description: "Rewrites the draft", prompt: "Rewrite the draft.", model: "moonshotai/kimi-k2.6", input: { draft: OfferDraftDto, changes: ChangesRequestedDto }, output: OfferDraftDto, maxVisits: 3 })
export class DraftEditorAgent {}
@WorkflowFinish({ name: "offer-workflow-finish", description: "The approved offer", input: { drafts: historyOf(OfferDraftDto) }, output: OfferDraftDto })
export class OfferWorkflowFinish {
  finish(input: { drafts: { current: { value: OfferDraftDto } } }): OfferDraftDto {
    return input.drafts.current.value;
  }
}
```
-->

## Earlier versions: `historyOf(XDto, { limit })`

A node that needs the versions a value went through declares `historyOf(XDto)` in its `input`
(#299 S56; there are no string tags). The field is `HistoryOf<Produced<XDto, P>>` —
`{ current, previous }`: the current value, and the earlier versions of that slot in this execution,
oldest first — every one, or at most `limit` (the latest ones).

<!-- snippet-context
import { Agent, Workflow, agent, caseOf, start } from "agboss";
import { historyOf, oneOf } from "agboss/dto";
import { ChangesRequestedDto, DraftApprovedDto, DraftEditorAgent, FirstDraftAgent, HistoryOfferWorkflowStart, OfferDraftDto, OfferWorkflowFinish, ShortlistDto } from "./history.components.js";
-->

```ts
@Agent({
  name: "draft-review-agent",
  description: "Reviews the latest draft against the two before it",
  prompt: "Review the draft.",
  model: "moonshotai/kimi-k2.6",
  input: { draft: historyOf(OfferDraftDto, { limit: 2 }) },
  output: oneOf(ChangesRequestedDto, DraftApprovedDto),
})
export class DraftReviewAgent {}

@Workflow({
  name: "history-offer-workflow",
  version: "1.0.0",
  flow: [
    start(HistoryOfferWorkflowStart)
      .returns(ShortlistDto)
      .toAgent(FirstDraftAgent)
      .returns(OfferDraftDto)
      .toAgent(DraftReviewAgent),

    agent(DraftReviewAgent)
      .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
      .switch(
        caseOf(ChangesRequestedDto, { about: OfferDraftDto }) // the changes are about this draft
          .toAgent(DraftEditorAgent)
          .returns(OfferDraftDto)
          .toAgent(DraftReviewAgent),
        caseOf(DraftApprovedDto)
          .toFinish(OfferWorkflowFinish), // input: { drafts: historyOf(OfferDraftDto) }
      ),
  ],
})
export class HistoryOfferWorkflow {}
```

| Review | `draft.current` | `draft.previous` |
| --- | --- | --- |
| 1 | v1 | `[]` |
| 2 | v2 | `[v1]` |
| 3 | v3 | `[v1, v2]` |
| 4 | v4 | `[v2, v3]` (`limit: 2`) |

- A `historyOf(XDto)` field needs a **current** `XDto` on every path into its node, else
  `[input.missing-on-path]` — also where the latest `XDto` is outdated. The replaced versions are
  its `previous`, never `[input.outdated-on-path]`.
- `previous` is built from the slot's `outdatedValues` (below): each version with its producer.
- The input message shows the current value as a field, then `### draft, earlier versions (oldest
  first)` and the versions as a JSON array of `{ producer, value }` (`[]` on the first visit).
- `limit` is a positive integer (`[input.history-limit]`); `describe` prints the field as
  `draft: … (historyOf, limit 2)`.

## Outdating: current values only

The latest value of a slot is not always a current one. Every value remembers what its step read
(`builtFrom`, #271): an agent's, action's or router's `input` fields — or, for an agent with `output`
and no `input`, every current value on the path before it. A **new value in a slot outdates
everything built from the slot's older value**, recursively: a job list found for the profile
before the user corrected it, the reviewer's notes about a draft that was rewritten since.

- A field reads only a **current** value and never falls back to an older one. Assembly proves it
  on every path, loops included: a field — required or `optional` — whose value is outdated on some
  path into its node fails with `[input.outdated-on-path]`, naming the path and the step that
  outdated it. `optional(XDto)` covers only paths where `XDto` was never produced; it is not a way
  for an outdated value to slip in.
- `[input.missing-on-path]` counts current values only: an outdated value is not "on the path".
- Outside cycles nothing is written: outdating by provenance works by itself.
- Scope is one execution: results of earlier executions on the thread are never carried over.
- Limits: data from the outside world is not tracked (a tool's price may be stale), and a list is
  outdated as a whole, never item by item.

### `{ about }`: the direction of a cycle

In a cycle whose classes are built from each other — the writer reads the reviewer's notes, the
reviewer reads the writer's draft — the **flow** states what one of the values is about (#299 S54):
`.returns(CritiqueDto, { about: DraftDto })` after a step that gives one class or a list
(`{ about: [PlanDto, BudgetEstimateDto] }` for several), and for a `oneOf` on the branch,
`caseOf(ArticleChangesDto, { about: DraftDto })` — never on `.returns(oneOf(…))`, whose variants
mean different things (an approval is no critique of the draft). A start's `.returns(…)` takes no `{ about }`:
its input answers nothing (a compile error, `[io.about-on-start]` at assembly). A new draft outdates the values
about the older one; a new value about it never outdates the draft. Components declare a plain
`output`; `OutputOf<X>` and the answer tools are those of the `output`.

<!--
```ts file=review.components.ts
import { Agent, WorkflowFinish, WorkflowStart } from "agboss";
import { Text, optional } from "agboss/dto";

export class ArticleRequestDto {
  @Text({ prompt: "what to write about" })
  topic!: string;
}
export class ResearchDto {
  @Text({ prompt: "what the research found" })
  facts!: string;
}
export class DraftDto {
  @Text({ prompt: "the draft" })
  text!: string;
}
export class ApprovalDto {
  @Text({ prompt: "why it is good to publish" })
  reason!: string;
}
export class ArticleChangesDto {
  @Text({ prompt: "what to change" })
  changes!: string;
}
export class ArticleDto {
  @Text({ prompt: "the article, ready to publish" })
  body!: string;
}
@WorkflowStart({ name: "article-workflow-start", description: "What to write about", input: ArticleRequestDto })
export class ArticleWorkflowStart {}
@Agent({ name: "researcher-agent", description: "Researches the subject", prompt: "Research it.", model: "moonshotai/kimi-k2.6", input: { request: ArticleRequestDto }, output: ResearchDto })
export class ResearcherAgent {}
@Agent({ name: "writer-agent", description: "Writes the article, or rewrites it from the notes", prompt: "Write it.", model: "moonshotai/kimi-k2.6", maxVisits: 4, input: { request: ArticleRequestDto, research: ResearchDto, changes: optional(ArticleChangesDto) }, output: DraftDto })
export class WriterAgent {}
@Agent({ name: "publisher-agent", description: "Prepares the approved draft", prompt: "Prepare it.", model: "moonshotai/kimi-k2.6", input: { draft: DraftDto, approval: ApprovalDto }, output: ArticleDto })
export class PublisherAgent {}
@WorkflowFinish({ name: "article-workflow-finish", description: "The article", output: ArticleDto })
export class ArticleWorkflowFinish {}
```
-->

<!-- snippet-context
import { Agent, Workflow, agent, caseOf, start } from "agboss";
import { oneOf } from "agboss/dto";
import { ApprovalDto, ArticleChangesDto, ArticleDto, ArticleRequestDto, ArticleWorkflowFinish, ArticleWorkflowStart, DraftDto, PublisherAgent, ResearchDto, ResearcherAgent, WriterAgent } from "./review.components.js";
-->

```ts
@Agent({
  name: "reviewer-agent",
  description: "Approves the draft or asks for changes",
  prompt: "Review the draft.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 4,
  input: { draft: DraftDto },
  output: oneOf(ApprovalDto, ArticleChangesDto),
})
export class ReviewerAgent {}

@Workflow({
  name: "article-workflow",
  version: "1.0.0",
  flow: [
    start(ArticleWorkflowStart)
      .returns(ArticleRequestDto)
      .toAgent(ResearcherAgent)
      .returns(ResearchDto)
      .toAgent(WriterAgent),

    agent(WriterAgent) // two ways in: the first draft, a rewrite
      .returns(DraftDto)
      .toAgent(ReviewerAgent)
      .returns(oneOf(ApprovalDto, ArticleChangesDto))
      .switch(
        caseOf(ArticleChangesDto, { about: DraftDto }) // the notes are about this draft
          .toAgent(WriterAgent),
        caseOf(ApprovalDto)
          .toAgent(PublisherAgent) // approval: built from the draft, current only with it
          .returns(ArticleDto)
          .toFinish(ArticleWorkflowFinish),
      ),
  ],
})
export class ArticleWorkflow {}
```

| Step | What happened | Outdated, why |
| --- | --- | --- |
| 2 | writer-agent → Draft#1 | — |
| 3 | reviewer-agent → Changes#1 (about Draft#1) | — |
| 4 | writer-agent → Draft#2 (read Changes#1) | Draft#1: replaced; Changes#1: about Draft#1 |
| 5 | reviewer-agent → Approval#1 (built from Draft#2) | — |
| 6 | publisher-agent reads Draft#2 and Approval#1 | — |

The same agents behind a hub router that may send to any of them at any time do not assemble —
an unapproved draft can never be published:

```text
[input.missing-on-path] writer-agent.research (ResearchDto) is not produced on the path article-workflow-start → editor-router → writer-agent
[input.outdated-on-path] publisher-agent.approval (ApprovalDto) is outdated on the path … → reviewer-agent → editor-router → writer-agent → editor-router → publisher-agent (built from DraftDto, replaced by writer-agent)
```

- A cycle of classes built from each other with no `{ about }` on any of their values →
  `[io.ambiguous-cycle]`, the hint naming where to add it: `write caseOf(ArticleChangesDto, {
  about: DraftDto }) after reviewer-agent`, or `write .returns(CritiqueDto, { about: DraftDto })
  after critique-action` for a value of one class or a list.
- `{ about: T }` means the **current** `T`. A producer whose values are `{ about: T }` and that reads
  `T` in two or more fields (`draft: DraftDto` and `drafts: historyOf(DraftDto)`) →
  `[io.ambiguous-about]`: read `T` in one field — with `historyOf(T)` the answers are about its
  current value (#271 S14 after #299 S56: without tags, two values of `T` are read only through a
  history).

### At run time

The runtime keeps the two channels the analyser reasons about, in the execution's checkpoint:

- **`scope`** holds **current values only** — one `ScopeValueRecord` per slot: `valueId`, `slot`,
  `producer` (a component name), `variant` (for a `oneOf`), `value`, and `builtFrom` (the
  `valueId`s its step read) and `about` (the slots its `{ about }` in the flow names, when it has
  one). `valueId` is `${nodeId}:${visitNumber}/${slot}` — `writer-agent:2/DraftDto`,
  `chat-workflow-start:1/WorkflowStartTextDto` — the same in tests and after a resume.
- **`outdatedValues`** is append-only: when a write renews a slot, the slot's older value and every
  value built from it, transitively, move there **in the same step**, each as an
  `OutdatedValueRecord` with `outdated: { byValueId, reason }`. `byValueId` is always the **root
  trigger** — the new value that started the cascade, whatever path reached the record (the direct
  cause is the outdated entry of its own `builtFrom`); `reason` is `OutdatedReason.Replaced` (its
  slot got a new value), `AboutReplaced` (it is an answer about a value that was outdated) or
  `BuiltFromReplaced` (it was built from one).

`builtFrom` follows the same rules as the analysis: a step's `input` fields; every current value for
an agent with `output` and no `input`; the value's own `{ about }` targets, even when its step does
not read them; never a value about the class the step writes. After the write a value keeps only the
sources still current — one its own write outdated (the draft a rewrite read) leaves its
`builtFrom`, as in the analysis. The cascade starts from current values
only, and `{ about }` protects its target directly only — through a third class the target is
outdated like any other value.

Nothing that reads the scope can see an outdated value — input messages, handlers' `input`,
finishes and the thread's history (finished executions' start and finish only) read `scope`, and an
outdated value is not in it. The record keeps them: `app.execute(…, { record: true })` returns both
channels in `result.record` (`scope`, `outdatedValues`; [Testing](Testing#asserting-outdating)),
also after a pause and a resume. Every cascade is one `onValuesOutdated` event
([Observability](Observability#outdated-values)) and one trace entry, "values outdated", under the
step that wrote:

```text
DraftDto#1 outdated: replaced by DraftDto#2 from writer-agent
ArticleChangesDto#1 outdated: about DraftDto#1, replaced by DraftDto#2 from writer-agent
```

The labels `DraftDto#2` are ordinals within a slot. A second execution on a thread starts with its
start input only: its `scope` and `outdatedValues` begin empty.

## Parallel branches

A branch of a launch (#273) sees the scope at the launch — the launching step's values written —
plus, in a per-item run, its item as the latest single `XDto`; its siblings' values enter the scope
only at the join, all at once, each built from what its branches read at the launch (a per-item run
counts as reading its list). Several values of one class from one join — copies of one agent, two
agents with one `output`, a per-item launch — are one `listOf(XDto)` slot, so a single `XDto` field
there is `[input.several-on-path]`.

A branch that returns a new value of a class another branch of the same launch read — directly, or
through what the value it read was built from — would bring that sibling's result to the join
already outdated: `[launch.branch-outdates-sibling]`, checked at the join whether anything reads it
later or not (#271 S13):

```text
[launch.branch-outdates-sibling] replanner-agent returns PlanDto, which researcher-agent of the same
launch was built from: researcher-agent's ResearchDto is outdated at the join of
planner-agent → toParallelAgents(researcher-agent, replanner-agent)
```

A per-item launch and the copies of one agent never trigger it: their join writes one list slot
(`listOf(PlanDto)` is not `PlanDto`), which no branch read.

At run time (#273 PR 2) the branches write nothing into the scope: each ends with an outcome
record, and the join writes every value at once — one outdating cascade — so siblings never outdate
each other, as the analysis says. A single value keeps its branch's id (`refund-policy-agent:1/RefundPolicyDto`);
a list the launching step's (`planner-agent:1/list:CritiqueDto`), its elements in listed / item order
and, when several agents gave it, each element with its own `producer` (`elementProducers` in the
record). Each value is built from what its branches read; a per-item run's item has its list's
`valueId`, so its result is built from the list.

## Quorums

After a quorum (#279, [Parallel](Parallel)) only **counted** answers enter the scope — not counted,
cancelled or rejected answers never do. They are the values the quorum's `.returns(…)` names (after
`.joinQuorum(…)`, or after each `group(…)`), written at the join like any launch's values, and the
next step reads them by type: a `listOf(XDto)` field gets the counted `XDto` answers, a single field
the latest single value. An answer a `.joinQuorum({ min })` may leave out is `optional(XDto)`, so a
required field reading it is `[input.missing-on-path]`, the message naming the agent a quorum may
leave out (`skills-score-agent may be left out of the quorum`) and the fix — the field as
`optional(SkillsScoreDto)` or `listOf(SkillsScoreDto)`.

A group's path carries its own agents' values only, required; the next node knows which group won
from the path it is on and from each `Produced<T, P>` value's `producer` — `P` is the union of the
agents that can be counted for it. A counted answer nobody reads is `[flow.unused-output]`.

## Child workflows

A child workflow (#263, [Workflow as a step](Workflow-as-a-step)) has a scope of its own, per
execution: it **starts with its start input only** — nothing of the parent's scope is visible
inside it, so a child node reading a class only the parent has is `[input.missing-on-path]` in the
child's own check, and a value the parent returns for nobody but the child's other nodes stays
unread (`[flow.unused-output]`). The edge into the child reads what its chosen start takes: the item
(per item) or the chain's value, plus the start's other required fields from the parent's path —
checked per edge (`[input.missing-on-path]`, `[input.outdated-on-path]`, `[input.several-on-path]`);
an optional field of a map start may be missing. The child gives back exactly one value — the
output of the finish it ended at: one `caseOf(XDto)` write (a case counts as read), a single
`.returns(XDto)` write, or, after `.toParallelWorkflows(W, …)`, one element of the join's
`listOf(oneOf(…))` slot; the values the child produced on its own path stay in its scope.

At run time (#263 PR 2) the child's state is its own — its scope, `outdatedValues`, path and steps —
and only its finish's output enters the parent's scope, written on the edge out of the child's
node. That value is built from what the child's start read of the parent's scope (its start input's
`valueId`s), so it is outdated like any other (#271 AC12): when the parent renews a value given to
the child's start — a loop's second pick — the child's earlier result moves to `outdatedValues`
(`OutdatedReason.BuiltFromReplaced`), and the second pass runs a new child execution on the new
input.

## Rules

Checked at assembly, all at once (`GraphRuleError`), each message naming the shortest path that
breaks it:

| Code | |
| --- | --- |
| `[input.missing-on-path]` | a required field has no current value on some path into the node |
| `[input.outdated-on-path]` | a field (required or `optional`) whose value is outdated on some path into the node |
| `[io.ambiguous-cycle]` | classes built from each other in a cycle, with no `{ about }` on their values |
| `[io.ambiguous-about]` | a producer whose values are `{ about: T }` reading `T` in two or more fields |
| `[io.about-on-start]` | `{ about }` on a start's `.returns(…)` — its input is no answer about anything (also a compile error) |
| `[input.never-produced]` | an `optional` field no path brings |
| `[input.several-on-path]` | a single field where several values arrive (one step's, or a join's list) |
| `[launch.branch-outdates-sibling]` | a branch of a launch renewing a value another branch of it was built from ([Parallel branches](#parallel-branches)) |
| `[flow.unused-output]` | a value returned on a path that no node reads (a `caseOf` counts as a read) |
| `[flow.ambiguous-field]` | two fields of one node that read one slot (`historyOf` gives the earlier versions) |
| `[input.history-limit]` | a `historyOf(…, { limit })` that is not a positive integer |
| `[flow.returns-mismatch]` | `.returns(…)` that is not what the step gives; a `.switch` without its `.returns(oneOf(…))` |
| `[dto.name]`, `[dto.duplicate-name]` | a DTO class on a path that does not end with `Dto`; two DTO classes of one name |

The analyser works on the whole graph to a fixed point, path-sensitively: a node keeps every
reachable state of the scope — per slot absent, current or outdated, who wrote it and what it was
built from — so the correlation between fields survives a merge; `maxVisits` takes no part in the
proof (a graph wrong on any iteration is wrong). The generated
`InputOf<X>` is the exact union of those states projected onto the node's `input` (up to 32 shapes;
above it one flat object, and `agboss check` says so).
