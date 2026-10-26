# Memory Management

A thread is a sequence of Terns (one execution each). What a router or an agent sees of
the thread's past is its **memory**: its window of the last turns and, when it uses a compaction
that writes summaries, the latest summaries of older ones. `@agboss/core/memory` holds the contract of an
agent's own strategy.

## The window: `uncompactedTurns`

A **turn** is a finished root execution of the thread, two lines — `start <start-name>: <input
JSON>` and `finish <finish-name>: <output JSON>` (#272 S8: a paused or failed execution is not a
turn; intermediate values never enter the history). Each agent and model router sees the thread's
last `uncompactedTurns` turns in full, as a message of its own before its input message. It is one
setting on four levels — `@Application` → `@Workflow` → `@Agent` / `@Router` — and the lowest level
that sets it wins (#120 AC4); nothing set → 5. `TurnLimit.ALL` is every turn. A code router reads
no memory: `uncompactedTurns` and `compaction` do not compile on it. There is no separate `memory`
setting, and no `override…` one.

## Compaction: `@Compaction` (#120 PR 3)

What is older than the window is a `@Compaction`'s — a class in `compactions/` (`*.compaction.ts`,
its prompt in `*.prompt.md`), its `name` ending with `-compaction`. It is named by `compaction: X`
on the same four levels, again the lowest wins; none anywhere → the window only.

| `strategy`                         | What it keeps                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `CompactionStrategy.SummaryQueue`  | every `turnsBetweenCompactions` turns older than the window become one self-contained summary; the latest `summaryQueueLength` are kept, the oldest leaves first |
| `CompactionStrategy.SingleSummary` | one summary, rewritten from the previous summary and the new turns at every compaction                              |
| `CompactionStrategy.None`          | no summaries: only the window; no model, no prompt, no parameters                                                    |
| `CompactionStrategy.Custom`        | your class's `compact(input)` gives the summaries (#382, [below](#a-custom-compaction-compactionstrategycustom-382)); `turnsBetweenCompactions` and `deps` only |

`SummaryQueue` and `SingleSummary` need a `model` (a chat model — a decision model is
`[compaction.decision-model]`); without one the decorator does not compile, and `None` with any
parameter does not compile either. `prompt` / `promptUrls` say how to summarise — none → the
strategy's built-in prompt. `summaryMaxTokens` is the summarising call's `max_tokens`, counted by
the model's server (`TokenLimit.MODEL_MAX` = what the model allows; thinking is off on that call, so it does
not spend the same limit).

<!-- snippet-context
import { Agent, Compaction, CompactionStrategy, TurnLimit, Workflow, WorkflowFinish, WorkflowStart, start } from "@agboss/core";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
@WorkflowStart({ name: "recall-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class TaskStart {}
@Agent({ name: "recall-agent", description: "Answers", prompt: "Answer the message.", model: "moonshotai/kimi-k2.6" })
export class Recaller {}
@WorkflowFinish({ name: "recall-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class AnswerFinish {}
-->

```ts
// compactions/conversation.compaction.ts — a queue of summaries
@Compaction({
  name: "conversation-compaction",
  description: "Summarises old turns of the conversation",
  prompt: "Summarise the turns under `Turns to compact`: what was asked, decided and is still open.",
  model: "moonshotai/kimi-k2.6",
  strategy: CompactionStrategy.SummaryQueue,
  turnsBetweenCompactions: 5,
  summaryQueueLength: 10,
  summaryMaxTokens: 400,
})
export class ConversationCompaction {}

// compactions/no-summaries.compaction.ts — the window only
@Compaction({
  name: "no-summaries-compaction",
  description: "No summaries: only the window of recent turns",
  strategy: CompactionStrategy.None,
})
export class NoSummariesCompaction {}

/** Sees the whole thread in full: no summaries needed. */
@Agent({
  name: "archive-agent",
  description: "Answers from the whole thread",
  prompt: "Answer from the thread.",
  model: "moonshotai/kimi-k2.6",
  uncompactedTurns: TurnLimit.ALL,
  compaction: NoSummariesCompaction,
})
export class ArchiveAgent {}

@Workflow({
  name: "compacting-desk-workflow",
  version: "1.0.0",
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Recaller)
      .toFinish(AnswerFinish),
  ],
  defaults: { models: { temperature: 0 }, router: { model: "typesafe/jev-1.13" } },
  uncompactedTurns: 4, // its agents and routers: the last 4 turns in full
  compaction: ConversationCompaction, // older turns: the queue's summaries
})
export class CompactingDesk {}
```

### A custom compaction: `CompactionStrategy.Custom` (#382)

A compaction whose class writes the summaries itself — a knowledge graph, a vector store, your own
summariser — `implements CompactionHandler`: one method, `compact(input)`, and its services through
`deps` (checked against the constructor by the compiler, created by the container at start; an
`ExecutionContext` reads the execution that is about to start). It takes `turnsBetweenCompactions`
and nothing of a model's: `model`, `prompt` / `promptUrls`, `summaryQueueLength` and
`summaryMaxTokens` do not compile with `CompactionStrategy.Custom`, and `agboss check` reports them
for a class the compiler did not check (`[compaction.invalid-setting]`); a class without a `compact`
method does not compile either and is `[compaction.missing-handler]` at assembly.

<!-- snippet-context
import { Compaction, CompactionStrategy, ExecutionContext, Injectable, type CompactionHandler, type CompactionInput, type CompactionTurn } from "@agboss/core";
@Injectable()
export class KnowledgeGraphService {
  saveFactsAndSummarize(
    _threadId: string,
    turns: readonly CompactionTurn[],
    previous: readonly string[],
  ): Promise<readonly string[]> {
    return Promise.resolve([...previous, `${String(turns.length)} turns saved`]);
  }
}
-->

```ts
// compactions/graph-memory.compaction.ts — the facts to a knowledge graph, its summary to readers
@Compaction({
  name: "graph-memory-compaction",
  description: "Keeps the facts of old turns in a knowledge graph",
  strategy: CompactionStrategy.Custom,
  turnsBetweenCompactions: 4,
  deps: [KnowledgeGraphService, ExecutionContext], // KnowledgeGraphService in the workflow's providers
})
export class GraphMemoryCompaction implements CompactionHandler {
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

It runs exactly when a model's would — the same window (the smallest `uncompactedTurns` among its
readers), the same `turnsBetweenCompactions`, lazily before the next turn's first read of the thread.
`input.turnsToCompact` are the turns due, oldest first, each a `CompactionTurn` — `startName`,
`input` (the start's input), `finishName`, `output` (the finish's output); `input.previousSummaries`
are what the last `compact()` gave (none before the first). Both go through the application's and the
workflow's PII policies first, as a model's input does: `compact()` reads `<email:7f3a91>`, never
the address. What it returns — at least one summary, none empty — is what readers see from now on,
in its order: it replaces the previous list. It is revealed (a token back to its value) and stored
as one summary record of the compaction, covering the thread from its first compacted turn, so the
next `compact()` reads it back as `previousSummaries`. A `compact()` that throws (its error as
`cause`), or returns no summary or an empty one, is `CompactionError` (`summaryMaxTokens`
`undefined`) — the new execution fails before any of its work, as for a model's. It calls no model:
no spend of its own (masking with a `detectWithModel` policy is counted), `result.compacted` gives
`summaries` and `summaryQueueLength` as the list's length.

`agboss describe` prints `graph-memory-compaction — strategy: custom (GraphMemoryCompaction.compact())
every 4 turns · older than 5 turns`; the class is part of the config hash — another class under the
same name is another configuration.

### The smallest window among the readers

A compaction is shared by every agent and model router that uses it, and each may see a different
window. It summarises everything older than the **smallest** `uncompactedTurns` among them, so no
one loses a turn; a larger window may see a small overlap. What a reader sees:

- in full: its window — and at least every turn its compaction has not summarised yet (between two
  compactions those gather up to `turnsBetweenCompactions`, so none falls between the window and
  the summaries);
- the compaction's latest summaries (`summaryQueueLength` of a queue, the one of a single summary)
  that its turns do not already cover — a reader whose window holds a summary's first turn reads
  those turns, not the summary.

A router that sees 1 turn and an agent that sees 3 share one queue: after turn 3 it summarises t1
and t2; on turn 4 the router reads the summary and t3, the agent t1–t3 in full and not the summary.
When every reader sees `TurnLimit.ALL`, nothing is ever summarised.

Each reader's window and the compaction in effect, and each compaction's settings and prompt, are
part of the workflow's config hash (#120 PR 4, [Terns and evaluation](Terns-and-evaluation#what-the-config-hash-covers-120-pr-4)):
another window on one router, or a longer queue, is another configuration.

### Before the next turn: when and how (#120 S132)

A compaction runs **lazily, before a new execution's first read of its thread** — never after a
turn. So a finished turn's answer is always kept, and a thread that ends never pays for a
compaction after its last turn. When the execution starts on an existing thread (after its budgets
pass, before its record, any model call or any step), each compaction that has
`turnsBetweenCompactions` turns older than its window summarises them, then the thread is read
(windows count turns: a failed or paused execution is none). Its model reads them — a queue with
the turns just before them as context only (`Earlier turns (context only):`, `Turns to compact:`),
a single summary with its current summary (`Current summary:`, `Turns to add:`) — and its answer is
stored as a summary of that compaction (`ExecutionRecordRepository`, by `(tenantId, threadId,
compaction)`: each compaction keeps its own). Its spend is `compaction:<name>` (category
`compaction`), the new execution's — first in its trace, counted in its budgets; with nothing left
of the execution's budget it waits for the next one. `result.compacted` lists what each compaction
did before the execution — `{ compaction, fromTurn, toTurn, summaries, summaryQueueLength }` — and
`agboss chat` prints `memory: conversation-compaction turns 1–5 → summary 1/10`.

**Too long:** a summary cut at `summaryMaxTokens` (`finish_reason: "length"`) is asked once more,
shorter; cut again — or its model call failed — the new execution fails with `CompactionError`
(code `compaction`; `compaction`, `summaryMaxTokens`, the failure as `cause`) before any of its own
work: no model call, no step, and its input is not kept as a turn. Never a cut summary: the earlier
turns stay unsummarised, and the next execution compacts them (this replaces #77's "a compaction
failure never fails the turn").

**PII (#120 S84 i):** the compaction's model reads the turns through the application's and the
workflow's PII policies — masked like any model input; a `blockWithRefusal` value shows as
`<kind>` (the turn itself was accepted by its readers). Its summary is revealed before it is
stored, so the store holds real values like the scope, and each reader's own policies mask it on
the way into its model (an agent that excludes a policy reads it as stored).

**Assembly rules**, all at once: `[name.kind-suffix]` (`-compaction`),
`[compaction.not-a-compaction]` (a class in `compaction` that is not a `@Compaction`),
`[compaction.invalid-setting]` (`turnsBetweenCompactions`, `summaryQueueLength`, `summaryMaxTokens`
not whole numbers from 1; a model's settings on a custom one), `[compaction.decision-model]`,
`[compaction.uncompacted-turns-invalid]`, `[compaction.missing-handler]` (a custom one without
`compact`).
Every compaction's `model` resolves to one provider by `serves` like any other
([Model providers](Model-providers): key `compactions.<name>`). `agboss describe` prints each
compaction in use with its window, and each agent's `uncompactedTurns` and compaction.

## Per agent: `memoryStrategy`

`@Agent({ memoryStrategy })` replaces what one agent sees of its memory. A strategy `extends
BaseMemoryStrategy`: `buildContext(context)` gets what the agent remembers — its turns in full and
its compaction's summaries, `limits` their counts — and returns the view (`{ history, summaries }`)
the agent reads, called before the agent's loop; the optional `updateMemory(turn)` runs after each turn (it may report the usage of
model calls it makes). The built-in `SlidingWindowStrategy` keeps a fixed window:

```ts
import { Agent } from "@agboss/core";
import { SlidingWindowStrategy } from "@agboss/core/memory";

/** A fixed window of the last two turns, no summaries. */
export class LastTwoTurns extends SlidingWindowStrategy {
  constructor() {
    super({ turns: 2, summaries: 0 });
  }
}

@Agent({
  name: "quick-responder",
  description: "Answers quick follow-ups",
  prompt: "Answer the follow-up briefly.",
  model: "moonshotai/kimi-k2.6",
  memoryStrategy: LastTwoTurns,
})
export class QuickResponder {}
```

## A custom strategy

A strategy is a component: dependencies through the constructor (`@Injectable({ deps })`), created
by the workflow's container when an agent names it.

```ts
import { Injectable, InjectionToken } from "@agboss/core";
import {
  BaseMemoryStrategy,
  type MemoryContext,
  type MemoryTurn,
  type MemoryUpdate,
  type MemoryView,
} from "@agboss/core/memory";

/** Where the facts live — any store; a value provider here. */
export interface FactStore {
  add(tenantId: string, threadId: string, fact: string): Promise<void>; // a thread is tenant + id
}
export const FACTS = new InjectionToken<FactStore>("FACTS");

@Injectable({ deps: [FACTS] })
export class FactExtractionStrategy extends BaseMemoryStrategy {
  constructor(private readonly facts: FactStore) {
    super();
  }

  /** Before the agent's loop: what it sees — here the last turn and no summaries. */
  buildContext({ history }: MemoryContext): MemoryView {
    return { history: history.slice(-1), summaries: [] };
  }

  /** After a turn: keep what matters (a model call here would report its usage). */
  override async updateMemory({ tenantId, threadId, turn }: MemoryTurn): Promise<MemoryUpdate> {
    await this.facts.add(tenantId, threadId, turn.start); // `start <name>: <input as JSON>`
    return {};
  }
}
```

Register the strategy's own dependencies in the workflow's `providers`
(`provide(FACTS, myFactStore)`); the strategy itself needs no entry.

## Testing

`mockLlm(ConversationCompaction).thenReturn(replyWith("t1 and t2 were asked"))` scripts a
compaction's model like any other ([Testing](Testing)); `replyWith("…", { truncated: true })` is a
summary cut at its limit (twice → `CompactionError`), `failWith(ModelFailure.ServerError)` a failed
call. Unscripted, a compaction writes a fixed summary at no cost; a `None` compaction calls no model
and has no script. A custom one calls no model either — `mockLlm(GraphMemoryCompaction)` is a setup
error; `mockOf(KnowledgeGraphService).saveFactsAndSummarize.mockResolvedValue(["…"])` replaces the
service its `compact()` uses (its calls are `mockOf(…).saveFactsAndSummarize.mock.calls`). One compaction on its own is `testCompaction(ConversationCompaction, { model: replyWith("…") })` (#395): `await compact({ previousSummaries, turnsToCompact })` gives the `summaries` readers see next and the `requests` its model was sent — a custom one's `compact()` on its own container ([Testing](Testing#unit-runners--one-component-on-its-own)). A strategy is a plain class, so its `buildContext` is tested with plain values.
