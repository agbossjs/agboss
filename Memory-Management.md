# Memory Management

A thread is a sequence of Terns (one execution each). What a router or an agent sees of
the thread's past is its **memory**: the last turns of the thread and, when the workflow compacts,
the latest summaries of older ones. `agboss/memory` holds the contract.

## The default: a window, plus compaction

- **Turns**: routers and agents see the thread's last `defaults.history.limit` turns — only finished
  executions, each as two lines, `start <start-name>: <input JSON>` and `finish <finish-name>:
  <output JSON>` (#272 S8: a paused or failed execution is not a turn; intermediate values never
  enter the history) — as a message of their own before the input message; an agent may set its
  own `historyLimit`.
- **Compaction** (`@Workflow({ compaction: { every, keep, model } })`): every `every` turns a model
  writes one self-contained summary; readers see the latest `keep` (`defaults.history.summaries`,
  per agent `historySummaries`, 0 = none). Details:
  [Terns and evaluation](Terns-and-evaluation#conversation-memory-compaction).

<!-- snippet-context
import { Agent, Workflow, WorkflowFinish, WorkflowSettings, WorkflowStart, start, type WorkflowDefinition } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
import { Reasoning } from "agboss/models";
@WorkflowStart({ name: "recall-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class TaskStart {}
@Agent({ name: "recall-agent", description: "Answers", prompt: "Answer the message.", model: "moonshotai/kimi-k2.6" })
export class Recaller {}
@WorkflowFinish({ name: "recall-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class AnswerFinish {}
-->

```ts
@Workflow({
  name: "compacting-desk-workflow",
  version: "1.0.0",
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Recaller)
      .toFinish(AnswerFinish),
  ],
  defaults: {
    models: { temperature: 0 },
    router: { model: "typesafe/jev-1.13" },
    history: { limit: 4, summaries: 3 },
  },
  compaction: {
    every: 2,
    keep: 3,
    model: { model: "moonshotai/kimi-k2.6", reasoning: Reasoning.off() },
  },
})
export class CompactingDesk implements WorkflowDefinition {
  settings() {
    return WorkflowSettings.builder()
      .build();
  }
}
```

## Per agent: `memoryStrategy`

`@Agent({ memoryStrategy })` replaces what one agent sees. A strategy `extends BaseMemoryStrategy`:
`buildContext(context)` returns the view (`{ history, summaries }`) the agent reads, called before
the agent's loop; the optional `updateMemory(turn)` runs after each turn (it may report the usage of
model calls it makes). The built-in `SlidingWindowStrategy` keeps a fixed window:

```ts
import { Agent } from "agboss";
import { SlidingWindowStrategy } from "agboss/memory";

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
import { Injectable, InjectionToken } from "agboss";
import {
  BaseMemoryStrategy,
  type MemoryContext,
  type MemoryTurn,
  type MemoryUpdate,
  type MemoryView,
} from "agboss/memory";

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

`mockCompaction()` (a `testWith` fixture) scripts the compaction model like any other
([Testing](Testing)); a strategy is a plain class, so its `buildContext` is tested with plain values.
