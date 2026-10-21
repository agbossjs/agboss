import { AGBossError } from "../core/errors.js";
import type { SummaryMaxTokens } from "./compaction.decorator.js";

/**
 * A compaction could not write its summary (#120 AC10): the summary was cut at `summaryMaxTokens`
 * twice — the first answer, then the one asked to be shorter — or its model call failed (the
 * failure as `cause`). Never a cut summary: the execution that finished the turn fails, its turn is
 * not kept, and the turns stay unsummarised for the next one.
 */
export class CompactionError extends AGBossError {
  static override readonly code: string = "compaction";
  override name = "CompactionError";
  /** The `@Compaction`'s name. */
  readonly compaction: string;
  /** Its `summaryMaxTokens`. */
  readonly summaryMaxTokens: SummaryMaxTokens;

  constructor(
    message: string,
    compaction: string,
    summaryMaxTokens: SummaryMaxTokens,
    cause?: unknown,
  ) {
    super(message, {
      ...(cause === undefined ? {} : { cause }),
      details: { compaction, summaryMaxTokens },
    });
    this.compaction = compaction;
    this.summaryMaxTokens = summaryMaxTokens;
  }
}
