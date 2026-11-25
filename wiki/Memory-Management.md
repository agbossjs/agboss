# Memory Management

A thread is a sequence of **turns**, one finished root execution each: two lines — `start <start-name>:
<input JSON>` and `finish <finish-name>: <output JSON>` (#272 S8: a paused or failed execution is not a
turn; intermediate values never enter the history). What a workflow, an agent or a model router
remembers of its thread is a **`@Memory` class** (#1303, #120 PR 3): the last turns in full — its
window — and, for what is older, summaries the memory writes. A workflow with no `memory` is
stateless: it reads and keeps no turn of its thread (an assembly warning when a start reuses a
`threadId` without one).

## `@Memory`

A memory is a class in `memories/` (`*.memory.ts`), its `name` ending with `-memory`. It is named by
`memory: X` on `@Workflow`, `@Agent` and `@Router` — the lowest level that sets one wins; on a code
router it does not compile. `NoMemory` (built in) on an agent or a router sees no earlier turn.

| Option | What it is |
| --- | --- |
| `ttl` | required: how long the thread's turns and summaries are kept — a duration (`days(30)`) or `Ttl.Forever` |
| `uncompactedTurns` | how many recent turns a reader sees in full, as a message of its own before its input message; default 5, `TurnLimit.All` is every turn |
| `turnsBetweenCompactions` | how many turns older than the window pile up before they are summarised; default 1 |
| `compaction` | what is older than the window: `{ strategy, … }`, below — or a `compact()` method on the class instead |

<!-- snippet-context
import { Agent, Workflow, CompactionStrategy, Memory, Ttl, TurnLimit, inline } from "@agboss/core";
import { days } from "@agboss/core/units";
-->

```ts
@Memory({
  name: "conversation-memory",
  description: "Remembers 8 turns in full and summarises the older ones",
  ttl: days(30),
  uncompactedTurns: 8,
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

@Memory({
  name: "archive-memory",
  description: "Every turn of the thread in full: no summaries needed",
  ttl: Ttl.Forever,
  uncompactedTurns: TurnLimit.All,
})
export class ArchiveMemory {}

// @Workflow({ …, memory: ConversationMemory }) — its agents and routers
@Agent({
  name: "archive-agent",
  description: "Answers from the whole thread",
  prompt: inline("Answer from the thread."),
  model: "moonshotai/kimi-k2.6",
  memory: ArchiveMemory,
})
export class ArchiveAgent {}
```

## Compaction

| `strategy` | What it keeps |
| --- | --- |
| `CompactionStrategy.SummaryQueue` | every `turnsBetweenCompactions` turns older than the window become one self-contained summary; the latest `summaryQueueLength` are kept, the oldest leaves first |
| `CompactionStrategy.SingleSummary` | one summary, rewritten from the previous summary and the new turns at every compaction |

Both take a `prompt` (a file, `inline(…)` or a list — none → the strategy's built-in prompt), a
`model` and `modelProvider` (the cascade as for an agent; a chat model — a decision model is refused)
and `summaryMaxTokens`, the summarising call's `max_tokens`, counted by the model's server
(`TokenLimit.ModelMax` = what the model allows; reasoning is off on that call, so it does not spend
the same limit). The summary is cut at the limit → one "shorter" retry, then `StepError.Memory`
(`memory`; `details.summaryMaxTokens`) — never a cut summary. Memory with neither `compaction` nor
`compact()` keeps the window only.

### A compaction of your own: `compact()`

A memory may write its summaries in code instead: a `compact({ previousSummaries, turnsToCompact })`
method on the class (sync or async, no `implements`) that returns the summaries readers see from now
on. Each turn is a `CompactionTurn` (`start`, `input`, `finish`, `output`, masked like a model's
input); the class's services come through `deps`, created by the container and run in the frame of
the execution's start. `compaction` and `compact()` together do not compile and fail assembly
(`[memory.conflicting-compaction]`).

## One memory, several readers

A memory summarises everything older than the **smallest** window among the agents and routers that
use it (a profile may set an agent's own window), so no one loses a turn: a reader sees in full its
window and every turn its memory has not summarised yet, and only the summaries its turns do not
cover.

## When it runs

A compaction runs lazily, before a new execution's first read of its thread (#120 S132), never after
a turn: a finished turn's answer is always kept, a thread that ends pays for none, and a
`StepError.Memory` fails the new execution before any of its work (no model call, no step, no turn
kept). It is observable: `onCompactionStart` / `onCompactionEnd` (`memory`, `turns`; the end adds
`costUsd` and `summaries`), `result.compacted` lists what each memory did before the execution
(`memory`, `fromTurn`, `toTurn`, `summaries`, `summaryQueueLength` for a queue), and the spend is
`memory:<name>` (category `memory`, [FinOps](FinOps)).

## Privacy

The memory's model reads the turns through the application's and the workflow's PII policies
(masked); the summary is revealed before it is stored (`ExecutionRecordRepository`, by `(tenantId,
threadId, memory)`), and each reader's own policies mask it at its boundary
([Guards](Guards)).

## Assembly rules and tests

`[memory.not-a-memory]`, `[memory.invalid-setting]` (`turnsBetweenCompactions`, `summaryQueueLength`,
`summaryMaxTokens` not whole numbers from 1), `[memory.uncompacted-turns-invalid]`,
`[memory.conflicting-compaction]`; the memory's `model` resolves to one provider through the cascade
like any other ([Model providers](Model-providers)). `agboss describe` prints each memory with its
window and strategy (`strategy: custom (GraphMemory.compact())` for a `compact()` one).

In a test the summary is scripted — `mockLlm(ConversationMemory).thenReturn(replyWith("…"))`
(`{ truncated: true }` = cut at the limit) — and unscripted it is a fixed text; `testUnit(Memory)` runs one
compaction on its own ([Testing](Testing)).
