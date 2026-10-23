import { CompactionStrategy } from "../compaction/compaction.decorator.js";
import type { ModelCompactionInUse } from "../compaction/plan.js";
import {
  CURRENT_SUMMARY_HEADING,
  EARLIER_TURNS_HEADING,
  TURNS_TO_ADD_HEADING,
  TURNS_TO_COMPACT_HEADING,
} from "../prompts/compaction.js";

/** What a compaction's model reads, from its parts: the turns as a reader's memory renders them. */
export interface SummaryInputParts {
  /** A single summary's current one; none yet → `(none yet)`. */
  readonly current?: string;
  /** A queue's earlier turns, read as context ("" for none). */
  readonly earlier: string;
  /** The turns due. */
  readonly due: string;
}

/** The input message of a compaction's model (#120 PR 3), the same at run time and in `testCompaction`. */
export function summaryInputTextOf(
  strategy: ModelCompactionInUse["strategy"],
  { current, earlier, due }: SummaryInputParts,
): string {
  if (strategy === CompactionStrategy.SingleSummary)
    return `${CURRENT_SUMMARY_HEADING}\n${current ?? "(none yet)"}\n\n${TURNS_TO_ADD_HEADING}\n${due}`;
  return (
    (earlier === "" ? "" : `${EARLIER_TURNS_HEADING}\n${earlier}\n\n`) +
    `${TURNS_TO_COMPACT_HEADING}\n${due}`
  );
}
