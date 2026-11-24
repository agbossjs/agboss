import type { UsageRecord } from "../finops/usage.js";
import type { HistoryTurn } from "../flow/runtime/history.js";

export type { HistoryTurn };

/** The thread memory an agent sees: summaries of older turns, then earlier turns — oldest first. */
export interface MemoryView {
  readonly summaries: readonly string[];
  readonly history: readonly HistoryTurn[];
}

/**
 * What an agent's strategy builds its context from, once per visit of the agent, before its model
 * calls: what the agent remembers of the thread (#120 PR 3) — its last turns in full (its
 * `uncompactedTurns`, and every turn its compaction has not summarised yet) and its compaction's
 * latest summaries — and how many of each that is (`limits`).
 */
export interface MemoryContext extends MemoryView {
  readonly agent: string;
  /** The agent's input message of this visit (#270 Q51). */
  readonly task: string;
  readonly limits: { readonly turns: number; readonly summaries: number };
}

/** A finished (not paused) turn of the thread, handed to every strategy in use after it. */
export interface MemoryTurn {
  /** The thread: its tenant and its id (#261 S72: the thread's key). */
  readonly tenantId: string;
  readonly threadId: string;
  readonly executionId: string;
  readonly turn: HistoryTurn;
  /** What is left of the run's budget; a strategy that calls a model does nothing at 0. */
  readonly budgetLeftUsd: number;
}

/** What an update did; the spend of its model calls goes to the run's cost report. */
export interface MemoryUpdate {
  readonly usage?: readonly UsageRecord[];
}

/**
 * How an agent remembers the thread: `buildContext` chooses what of the thread memory the agent's
 * model calls see; `updateMemory` runs after every finished turn. Set per agent with
 * `@Agent({ memoryStrategy })` (resolved by the workflow's container — `@Injectable({ deps })` for
 * dependencies); other agents use the built-in strategy: their `uncompactedTurns` and `compaction`.
 */
export abstract class BaseMemoryStrategy {
  abstract buildContext(context: MemoryContext): MemoryView | Promise<MemoryView>;

  /** After a finished turn (optional: a strategy without it keeps no memory of its own). */
  updateMemory?(turn: MemoryTurn): Promise<MemoryUpdate>;
}
