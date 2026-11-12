import { AGBossError } from "../core/errors.js";
import type { SummaryMaxTokens } from "./compaction.decorator.js";

/** What a failed compaction takes (#906): the message, the compaction and the cut limit. */
export interface CompactionErrorOptions {
  readonly message: string;
  /** The compaction's `name`. */
  readonly compaction: string;
  /** The limit the summary was cut at; `undefined` for a custom compaction's failure. */
  readonly summaryMaxTokens: SummaryMaxTokens | undefined;
  /** The model call's failure, or what the custom compaction's `compact()` threw. */
  readonly cause?: unknown;
}

/**
 * A compaction could not write its summary (#120 AC10): the summary was cut at `summaryMaxTokens`
 * twice — the first answer, then the one asked to be shorter — or its model call failed (the
 * failure as `cause`). Never a cut summary: the compaction runs before a new execution reads its
 * thread (#120 S132), so that execution fails before any of its work — no model call of its own, no
 * step, no turn kept — and the earlier turns stay unsummarised for the next one. A custom
 * compaction's (#382): its `compact()` threw (as `cause`) or gave no summaries, or an empty one.
 */
export class CompactionError extends AGBossError {
  static override readonly code = "compaction" as const;
  declare readonly code: typeof CompactionError.code;
  override name = "CompactionError";
  /** The `@Compaction`'s name. */
  readonly compaction: string;
  /** Its `summaryMaxTokens`; `undefined` for a custom compaction (#382), which has none. */
  readonly summaryMaxTokens: SummaryMaxTokens | undefined;

  constructor(options: CompactionErrorOptions) {
    const { message, compaction, summaryMaxTokens, cause } = options;
    super(message, {
      cause,
      details: { compaction, ...(summaryMaxTokens === undefined ? {} : { summaryMaxTokens }) },
    });
    this.compaction = compaction;
    this.summaryMaxTokens = summaryMaxTokens;
  }
}
