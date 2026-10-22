import { callerFile } from "../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import type { TokenLimit, TurnLimit } from "../config/types.js";

/**
 * Compaction (#120 PR 3): how the turns of a thread older than its readers' window are summarised.
 * A `@Compaction` class is named by `compaction: X` on `@Application`, `@Workflow`, `@Agent` and
 * `@Router` — one setting, the lowest level that sets it wins. How many recent turns a reader sees
 * in full is not the compaction's: `uncompactedTurns` on the same levels. A compaction summarises
 * every turn older than the smallest `uncompactedTurns` among the agents and routers that use it,
 * so no one loses a turn (a larger window may see a small overlap).
 */

/** How a compaction keeps what is older than the window. */
export enum CompactionStrategy {
  /** Each compaction writes a new self-contained summary; the latest `summaryQueueLength` are kept. */
  SummaryQueue = "summary-queue",
  /** One summary, rewritten from the previous summary and the new turns at every compaction. */
  SingleSummary = "single-summary",
  /** No summaries: only the window of recent turns is shown, older turns are not. */
  None = "none",
  /**
   * The class's `compact(input)` (`implements CompactionHandler`, #382) gives the summaries readers
   * see from the previous ones and the turns due — no model of the framework's, no prompt.
   */
  Custom = "custom",
}

/** Recent turns a reader sees in full when no level sets `uncompactedTurns`. */
export const DEFAULT_UNCOMPACTED_TURNS = 5;

/** How many recent turns a reader sees in full: a whole number from 0, or `TurnLimit.ALL`. */
export type UncompactedTurns = number | TurnLimit;

/** The token limit of one summary: the call's `max_tokens`, or `TokenLimit.MODEL_MAX` — what the model allows. */
export type SummaryMaxTokens = number | TokenLimit.MODEL_MAX;

/** What a compaction that writes summaries declares. */
interface SummarisingOptions {
  /** Ends with `-compaction` (`conversation-compaction`). */
  readonly name: string;
  readonly description: string;
  /** How to summarise; inline, and / or files next to the class. None → the built-in prompt. */
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  /** The chat model that writes the summaries (its provider is resolved by `serves`, #266). */
  readonly model: string;
  /** How many turns older than the window gather before they are summarised (from 1). */
  readonly turnsBetweenCompactions: number;
  /**
   * The summarising call's `max_tokens`, counted by the model's server; `TokenLimit.MODEL_MAX` = what the
   * model allows. A summary cut at the limit is asked once more, shorter, then `CompactionError`.
   */
  readonly summaryMaxTokens: SummaryMaxTokens;
}

/** `CompactionStrategy.SummaryQueue`: a queue of the latest `summaryQueueLength` summaries. */
export interface SummaryQueueCompactionOptions extends SummarisingOptions {
  readonly strategy: CompactionStrategy.SummaryQueue;
  /** How many summaries are kept; the oldest leaves first (from 1). */
  readonly summaryQueueLength: number;
}

/** `CompactionStrategy.SingleSummary`: one summary, rewritten at every compaction. */
export interface SingleSummaryCompactionOptions extends SummarisingOptions {
  readonly strategy: CompactionStrategy.SingleSummary;
  readonly summaryQueueLength?: never;
}

/** `CompactionStrategy.None`: no model, no prompt, no parameters. */
export interface NoSummaryCompactionOptions {
  readonly name: string;
  readonly description: string;
  readonly strategy: CompactionStrategy.None;
  readonly prompt?: never;
  readonly promptUrls?: never;
  readonly model?: never;
  readonly turnsBetweenCompactions?: never;
  readonly summaryQueueLength?: never;
  readonly summaryMaxTokens?: never;
}

/**
 * `CompactionStrategy.Custom` (#382): the class's `compact(input)` writes the summaries; its
 * constructor takes `deps`, created by the container. No model, prompt or summary limits.
 */
export interface CustomCompactionOptions<TDeps extends readonly Token[] = readonly Token[]> {
  readonly name: string;
  readonly description: string;
  readonly strategy: CompactionStrategy.Custom;
  /** How many turns older than the window gather before `compact()` is called (from 1). */
  readonly turnsBetweenCompactions: number;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: TDeps;
  readonly prompt?: never;
  readonly promptUrls?: never;
  readonly model?: never;
  readonly summaryQueueLength?: never;
  readonly summaryMaxTokens?: never;
}

/** The options of a compaction the framework runs: every strategy but `Custom`. */
export type BuiltInCompactionOptions =
  SummaryQueueCompactionOptions | SingleSummaryCompactionOptions | NoSummaryCompactionOptions;

/** The options of `@Compaction`, by strategy. */
export type CompactionOptions = BuiltInCompactionOptions | CustomCompactionOptions;

/** One turn a custom compaction compacts: its start and input, its finish and output (#382). */
export interface CompactionTurn {
  /** The `@WorkflowStart` it began at (`chat-workflow-start`). */
  readonly startName: string;
  /** The start's input, masked by the PII policies. */
  readonly input: unknown;
  /** The `@WorkflowFinish` it ended at. */
  readonly finishName: string;
  /** The finish's output, masked by the PII policies. */
  readonly output: unknown;
}

/** What `compact()` reads: the summaries readers see now, and the turns due, oldest first. */
export interface CompactionInput {
  /** What the last `compact()` gave (none before the first), masked by the PII policies. */
  readonly previousSummaries: readonly string[];
  /** The turns due: older than the readers' window, `turnsBetweenCompactions` or more. */
  readonly turnsToCompact: readonly CompactionTurn[];
}

/** A custom compaction's class (`CompactionStrategy.Custom`): the summaries readers see from now on. */
export interface CompactionHandler {
  /** The summaries readers see from now on (at least one, none empty), replacing the previous ones. */
  compact(input: CompactionInput): Promise<readonly string[]> | readonly string[];
}

/** What `@Compaction` recorded: its options, its dependencies and the file it is declared in. */
export type CompactionMeta = (
  BuiltInCompactionOptions | (CustomCompactionOptions & { readonly deps: readonly Token[] })
) & { readonly source?: string };

/** `@Compaction({ name, description, strategy, … })` — an empty class carrying its options. */
export function Compaction(options: BuiltInCompactionOptions): <C extends Class>(value: C) => C;
/** `CompactionStrategy.Custom`: the class implements `CompactionHandler`, its constructor takes `deps`. */
export function Compaction<const TDeps extends readonly Token[] = []>(
  options: CustomCompactionOptions<TDeps>,
): <C extends new (...args: ResolvedAll<TDeps>) => CompactionHandler>(value: C) => C;
export function Compaction(options: CompactionOptions): <C extends Class>(value: C) => C {
  const source = callerFile();
  const recorded: CompactionMeta =
    options.strategy === CompactionStrategy.Custom
      ? { ...options, deps: options.deps ?? [] }
      : options;
  return <C extends Class>(value: C): C => {
    recordComponent(value, {
      kind: "compaction",
      meta: source === undefined ? recorded : { ...recorded, source },
    });
    return value;
  };
}

/** A class's `@Compaction` options, if it is one. */
export const compactionMetaOf = (cls: Class): CompactionMeta | undefined => {
  const component = componentOf(cls);
  return component?.kind === "compaction" ? component.meta : undefined;
};

/** Whether a compaction writes summaries with a model; `None` and `Custom` do not. */
export const isSummarising = (
  meta: CompactionMeta,
): meta is (SummaryQueueCompactionOptions | SingleSummaryCompactionOptions) & {
  readonly source?: string;
} =>
  meta.strategy === CompactionStrategy.SummaryQueue ||
  meta.strategy === CompactionStrategy.SingleSummary;

/** Whether a compaction's class writes the summaries itself (`CompactionStrategy.Custom`, #382). */
export const isCustomCompaction = (
  meta: CompactionMeta,
): meta is CustomCompactionOptions & {
  readonly deps: readonly Token[];
  readonly source?: string;
} => meta.strategy === CompactionStrategy.Custom;
