import type { Usd } from "../../units/index.js";
import type { ExecutionEvent } from "./execution-event.js";

/**
 * A memory starts compacting (#1303, `onCompactionStart`): before a new execution's first read of
 * its thread, the `@Memory` named by `memory` summarises `turns` turns older than its readers' window.
 */
export interface CompactionStartEvent extends ExecutionEvent {
  /** The `@Memory`'s name. */
  readonly memory: string;
  /** How many turns are compacted. */
  readonly turns: number;
}

/** A memory ended compacting (`onCompactionEnd`): what it spent and how many summaries readers see now. */
export interface CompactionEndEvent extends CompactionStartEvent {
  /** What its model calls cost (`0` for a code compaction); the spend is already in the ledger. */
  readonly costUsd: Usd;
  /** How many summaries readers see now. */
  readonly summaries: number;
}
