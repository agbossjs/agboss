import type { AgentsConfigOf } from "../config/types.js";
import { TurnLimit } from "../config/types.js";
import { TokenLimit } from "../config/types.js";
import type { AssembledCompactions } from "./assembly.js";
import {
  CompactionStrategy,
  type SummaryMaxTokens,
  type UncompactedTurns,
} from "./compaction.decorator.js";

/**
 * A workflow's memory at run time (#120 PR 3): each reader's window and compaction, and every
 * compaction that writes summaries with the smallest window among its readers — built from the
 * config (a profile may change windows and settings) over the assembled readers.
 */

/** A compaction that writes summaries, as it runs. */
export interface CompactionInUse {
  readonly name: string;
  readonly strategy: CompactionStrategy.SummaryQueue | CompactionStrategy.SingleSummary;
  readonly prompt: string;
  /** The smallest window among its readers: it summarises every turn older than this. */
  readonly window: UncompactedTurns;
  readonly turnsBetweenCompactions: number;
  /** How many of its summaries a reader sees: the queue's length, 1 for a single summary. */
  readonly summaryQueueLength: number;
  readonly summaryMaxTokens: SummaryMaxTokens;
}

/** One reader of the thread: its window and, when it has one that writes summaries, its compaction. */
export interface MemoryReader {
  readonly window: UncompactedTurns;
  readonly compaction?: CompactionInUse;
}

/** The workflow's memory: by reader, and the compactions that write summaries. */
export interface MemoryPlan {
  /** By agent / model router name; a name not here reads the workflow's window, no summaries. */
  readonly readers: ReadonlyMap<string, MemoryReader>;
  readonly compactions: readonly CompactionInUse[];
  /** What a reader not listed reads. */
  readonly fallback: MemoryReader;
}

/** A window as a count to compare: `TurnLimit.ALL` is above every number. */
const sizeOf = (window: UncompactedTurns): number =>
  window === TurnLimit.ALL ? Number.POSITIVE_INFINITY : window;

/**
 * The window of a compaction: the smallest among its readers' (`TurnLimit.ALL` when every reader
 * sees every turn — then nothing is ever summarised).
 */
export function windowOfCompaction(windows: readonly UncompactedTurns[]): UncompactedTurns {
  const smallest = Math.min(...windows.map(sizeOf));
  return Number.isFinite(smallest) ? smallest : TurnLimit.ALL;
}

type Settings = NonNullable<AgentsConfigOf<string>["compactions"]>[string];

const isQueue = (settings: Settings): boolean =>
  settings.strategy === CompactionStrategy.SummaryQueue;

/** Each reader's window: an agent's own in the config (a profile may set it), else its own, else the workflow's. */
function windowsOf(
  config: AgentsConfigOf<string>,
  assembled: AssembledCompactions | undefined,
): ReadonlyMap<string, UncompactedTurns> {
  const agents = new Map(Object.entries(config.agents));
  const names = [...new Set([...agents.keys(), ...(assembled?.readers.keys() ?? [])])];
  return new Map(
    names.map((name) => [
      name,
      agents.get(name)?.uncompactedTurns ??
        assembled?.readers.get(name)?.uncompactedTurns ??
        config.defaults.uncompactedTurns,
    ]),
  );
}

/** A compaction in use as it runs, from its settings (a profile may change them); none for `None`. */
function compactionInUse(
  loaded: AssembledCompactions["compactions"][number],
  settings: Settings | undefined,
  windows: readonly UncompactedTurns[],
): CompactionInUse[] {
  if (settings?.strategy === CompactionStrategy.None || settings?.model === undefined) return [];
  const queue = isQueue(settings);
  return [
    {
      name: loaded.name,
      strategy: queue ? CompactionStrategy.SummaryQueue : CompactionStrategy.SingleSummary,
      prompt: loaded.prompt,
      window: windowOfCompaction(windows),
      turnsBetweenCompactions: settings.turnsBetweenCompactions ?? 1,
      summaryQueueLength: queue ? (settings.summaryQueueLength ?? 1) : 1,
      summaryMaxTokens: settings.model.maxTokens ?? TokenLimit.MODEL_MAX,
    },
  ];
}

/** The workflow's memory plan. */
export function memoryPlanOf(
  config: AgentsConfigOf<string>,
  assembled: AssembledCompactions | undefined,
): MemoryPlan {
  const windows = windowsOf(config, assembled);
  const usersOf = (compaction: string): UncompactedTurns[] =>
    [...windows].flatMap(([name, window]) =>
      assembled?.readers.get(name)?.compaction === compaction ? [window] : [],
    );
  const compactions = (assembled?.compactions ?? []).flatMap((loaded) =>
    compactionInUse(loaded, config.compactions?.[loaded.name], usersOf(loaded.name)),
  );
  const byName = new Map(compactions.map((compaction) => [compaction.name, compaction]));
  const readers = new Map(
    [...windows].map(([name, window]): [string, MemoryReader] => {
      const named = assembled?.readers.get(name)?.compaction;
      const compaction = named === undefined ? undefined : byName.get(named);
      return [name, compaction === undefined ? { window } : { window, compaction }];
    }),
  );
  return { readers, compactions, fallback: { window: config.defaults.uncompactedTurns } };
}

/** A reader's plan: its own, else the workflow's window without summaries. */
export const readerOf = (plan: MemoryPlan, name: string): MemoryReader =>
  plan.readers.get(name) ?? plan.fallback;
