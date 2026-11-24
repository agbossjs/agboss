import type { PromptSource } from "../components/prompt-source.js";
import { callerFile } from "../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import type { TokenLimit, TurnLimit } from "../config/types.js";
import { Ttl, type Milliseconds } from "../units/index.js";

/**
 * Memory (#1303): what a workflow or an agent remembers of its thread — how long the thread is kept
 * (`ttl`), how many recent turns a reader sees in full (`uncompactedTurns`) and how the turns older
 * than that are summarised (`compaction`, or the class's own `compact(input)`). A `@Memory` class is
 * named by `memory: X` on `@Workflow`, `@Agent` and `@Router`; the lowest level that sets one wins.
 * A workflow without `memory` is stateless; `NoMemory` on an agent or a router opts it out of its
 * workflow's. A memory summarises every turn older than the smallest `uncompactedTurns` among the
 * agents and routers that use it, so no one loses a turn (a larger window may see a small overlap).
 */

/** How a memory keeps what is older than the window. */
export enum CompactionStrategy {
  /** Each compaction writes a new self-contained summary; the latest `summaryQueueLength` are kept. */
  SummaryQueue = "summary-queue",
  /** One summary, rewritten from the previous summary and the new turns at every compaction. */
  SingleSummary = "single-summary",
}

/** Recent turns a reader sees in full when its memory sets no `uncompactedTurns` (a workflow without memory sees none). */
export const DEFAULT_UNCOMPACTED_TURNS = 5;

/** How many recent turns a reader sees in full: a whole number from 0, or `TurnLimit.All`. */
export type UncompactedTurns = number | TurnLimit;

/** The token limit of one summary: the call's `max_tokens`, or `TokenLimit.ModelMax` — what the model allows. */
export type SummaryMaxTokens = number | TokenLimit.ModelMax;

/** What a summarising memory sets besides its strategy: how its model is told and called. */
export interface SummariserOptions {
  /** How to summarise: a file next to the class, `inline(…)`, or a list of them. None → the built-in prompt. */
  readonly prompt?: PromptSource;
  /** The `@ModelProvider` class that serves the summarising model; left out, the workflow's, else the application's (#1313). */
  readonly modelProvider?: Class;
  /** The chat model, or a role of the provider (`"fast"`); left out, the provider's default. */
  readonly model?: string;
  /**
   * The summarising call's `max_tokens`, counted by the model's server; `TokenLimit.ModelMax` = what the
   * model allows (the default). A summary cut at the limit is asked once more, shorter, then `StepError.Memory`.
   */
  readonly summaryMaxTokens?: SummaryMaxTokens;
}

/** `CompactionStrategy.SummaryQueue`: a queue of the latest `summaryQueueLength` summaries. */
export interface SummaryQueueCompaction extends SummariserOptions {
  readonly strategy: CompactionStrategy.SummaryQueue;
  /** How many summaries are kept; the oldest leaves first (from 1). */
  readonly summaryQueueLength: number;
}

/** `CompactionStrategy.SingleSummary`: one summary, rewritten at every compaction. */
export interface SingleSummaryCompaction extends SummariserOptions {
  readonly strategy: CompactionStrategy.SingleSummary;
  readonly summaryQueueLength?: never;
}

/** The declarative compaction of a `@Memory`: the framework's model writes the summaries. */
export type MemoryCompaction = SummaryQueueCompaction | SingleSummaryCompaction;

/** What every `@Memory` sets. */
export interface MemoryBaseOptions {
  /** Ends with `-memory` (`support-chat-memory`). */
  readonly name: string;
  readonly description: string;
  /** How long an idle thread is kept: a duration, or `Ttl.Forever`. */
  readonly ttl: Milliseconds | Ttl.Forever;
  /** How many recent turns a reader sees in full: a whole number from 0, or `TurnLimit.All` (default 5). */
  readonly uncompactedTurns?: UncompactedTurns;
  /** How many turns older than the window gather before they are summarised (from 1; default 1). */
  readonly turnsBetweenCompactions?: number;
}

/** The options of a `@Memory` that summarises with the framework's model. */
export interface DeclarativeMemoryOptions extends MemoryBaseOptions {
  readonly compaction: MemoryCompaction;
  readonly deps?: never;
}

/** The options of a `@Memory` that keeps the window only, or whose class compacts in code. */
export interface CodeMemoryOptions<
  TDeps extends readonly Token[] = readonly Token[],
> extends MemoryBaseOptions {
  readonly compaction?: never;
  /** Constructor dependencies of the class that defines `compact(input)`, in order; checked against the constructor. */
  readonly deps?: TDeps;
}

/** The options of `@Memory`. */
export type MemoryOptions = DeclarativeMemoryOptions | CodeMemoryOptions;

/** One turn a code compaction compacts: its start and input, its finish and output. */
export interface CompactionTurn {
  /** The `@WorkflowStart` it began at (`chat-workflow-start`). */
  readonly start: string;
  /** The start's input, masked by the PII policies. */
  readonly input: unknown;
  /** The `@WorkflowFinish` it ended at. */
  readonly finish: string;
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

/** What `@Memory` recorded: its options, its dependencies and the file it is declared in. */
export interface MemoryMeta {
  readonly name: string;
  readonly description: string;
  readonly ttl: Milliseconds | Ttl.Forever;
  readonly uncompactedTurns?: UncompactedTurns;
  readonly turnsBetweenCompactions?: number;
  readonly compaction?: MemoryCompaction;
  readonly deps: readonly Token[];
  readonly source?: string;
}

/** The class's code compaction: `compact(input)` for the summaries readers see from now on. */
export type CompactMethod = (
  input: CompactionInput,
) => Promise<readonly string[]> | readonly string[];

/**
 * `@Memory({ name, description, ttl, … })`: an empty class carrying its options — and, for a code
 * compaction, a `compact(input)` method (sync or async, no `implements`) whose constructor takes `deps`.
 * `compaction` and `compact()` together fail at compile time, and at assembly (`[memory.conflicting-compaction]`).
 */
export function Memory(
  options: DeclarativeMemoryOptions,
): <C extends new () => { readonly compact?: never }>(value: C) => C;
export function Memory<const TDeps extends readonly Token[] = []>(
  options: CodeMemoryOptions<TDeps>,
): <C extends new (...args: ResolvedAll<TDeps>) => { compact?: CompactMethod }>(value: C) => C;
export function Memory(options: MemoryOptions): <C extends Class>(value: C) => C {
  const source = callerFile();
  const recorded: MemoryMeta = { ...options, deps: options.deps ?? [] };
  return <C extends Class>(value: C): C => {
    recordComponent(value, {
      kind: "memory",
      meta: source === undefined ? recorded : { ...recorded, source },
    });
    return value;
  };
}

/** The memory that keeps no turn of the thread: an `@Agent` or `@Router` that names it sees only the current turn. */
@Memory({
  name: "no-memory",
  description: "Remembers no earlier turn of the thread",
  ttl: Ttl.Forever,
  uncompactedTurns: 0,
})
export class NoMemory {}

/** A class's `@Memory` options, if it is one. */
export const memoryMetaOf = (cls: Class): MemoryMeta | undefined => {
  const component = componentOf(cls);
  return component?.kind === "memory" ? component.meta : undefined;
};

/** Whether a memory's class compacts in code: it has a `compact` method. */
export const hasCompactMethod = (cls: Class): boolean =>
  typeof (Reflect.get(cls.prototype as object, "compact") as unknown) === "function";

/** The window of a memory's readers: its own, else the default. */
export const windowOf = (meta: MemoryMeta): UncompactedTurns =>
  meta.uncompactedTurns ?? DEFAULT_UNCOMPACTED_TURNS;

/** The workflow's window: its memory's; a workflow without `memory` is stateless — no earlier turn (#1303b, D8). */
export const workflowWindowOf = (memory: Class | undefined): UncompactedTurns => {
  const meta = memory === undefined ? undefined : memoryMetaOf(memory);
  return meta === undefined ? 0 : windowOf(meta);
};

/** The window of a `@Memory` class. */
export const windowOfClass = (memory: Class): UncompactedTurns => workflowWindowOf(memory);

/** What a memory does with the turns older than its window. */
export const WINDOW_ONLY = "window" as const;
/** A memory whose class's `compact()` writes the summaries. */
export const CUSTOM_COMPACTION = "custom" as const;

/** How a memory compacts: with its model's strategy, in code, or not at all (the window only). */
export type MemoryMode = CompactionStrategy | typeof CUSTOM_COMPACTION | typeof WINDOW_ONLY;

/** How a memory class compacts. A class with both is `custom` here; the assembly rules refuse it. */
export const modeOf = (cls: Class, meta: MemoryMeta): MemoryMode => {
  if (hasCompactMethod(cls)) return CUSTOM_COMPACTION;
  return meta.compaction?.strategy ?? WINDOW_ONLY;
};
