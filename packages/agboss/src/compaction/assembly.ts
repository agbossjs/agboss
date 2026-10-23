import type { AgentMeta } from "../components/meta-types.js";
import type { Class } from "../components/injection.js";
import type { PromptLoader } from "../components/prompt-render.js";
import type { CompactionSettings } from "../config/types.js";
import { NodeKind } from "../flow/ast.js";
import { isCodeRouter } from "../flow/decorators/router.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { throwIfViolated } from "../graph/rule-error.js";
import { Reasoning } from "../models/reasoning.js";
import { SINGLE_SUMMARY_PROMPT, SUMMARY_QUEUE_PROMPT } from "../prompts/compaction.js";
import { compactionViolations } from "./checks.js";
import {
  CompactionStrategy,
  compactionMetaOf,
  isCustomCompaction,
  isSummarising,
  type CompactionMeta,
  type UncompactedTurns,
} from "./compaction.decorator.js";
import { effectiveCompactions, type CompactionLevels, type MemoryReaderElement } from "./levels.js";

/**
 * A workflow's compactions as assembled (#120 PR 3): each reader's compaction and own window, and
 * every compaction in use with its prompt read (its own, else its strategy's built-in one). The
 * settings a profile may change go to the config (`compactions`); any rule broken fails the
 * assembly, all at once.
 */

/** One compaction in use: what it summarises with. */
export interface LoadedCompaction {
  readonly type: Class;
  readonly name: string;
  readonly description: string;
  readonly strategy: CompactionStrategy;
  /** Its prompt, read and rendered; its strategy's built-in one when it has none ("" for `None`, `Custom`). */
  readonly prompt: string;
  /** Whether `prompt` is the class's own. */
  readonly isOwnPrompt: boolean;
}

/** One reader of the thread: the compaction it uses (by name) and its own window, if it sets one. */
export interface CompactionReader {
  readonly compaction?: string;
  readonly uncompactedTurns?: UncompactedTurns;
}

/** A workflow's compactions: every one in use and each reader's. */
export interface AssembledCompactions {
  readonly compactions: readonly LoadedCompaction[];
  /** By agent / model router name. */
  readonly readers: ReadonlyMap<string, CompactionReader>;
}

/** What the levels are: the application's and the workflow's settings. */
export interface CompactionOwners {
  readonly application?: CompactionLevels["application"];
  readonly workflow: CompactionLevels["workflow"];
}

/** The readers of the graph: its agents and its model routers (a code router reads no memory). */
function readersOf(agents: readonly AgentMeta[], graph: RuntimeGraph): MemoryReaderElement[] {
  const routers = [...graph.nodes.values()].flatMap((node): MemoryReaderElement[] => {
    if (node.declaration.kind !== NodeKind.Router) return [];
    const { options } = node.declaration;
    return isCodeRouter(options) ? [] : [options];
  });
  return [...agents, ...routers];
}

const builtInPromptOf = (strategy: CompactionStrategy): string =>
  strategy === CompactionStrategy.SingleSummary ? SINGLE_SUMMARY_PROMPT : SUMMARY_QUEUE_PROMPT;

const hasOwnPrompt = (meta: CompactionMeta): boolean =>
  (meta.prompt ?? "") !== "" || (meta.promptUrls ?? []).length > 0;

async function loaded(cls: Class, loader: PromptLoader): Promise<LoadedCompaction[]> {
  const meta = compactionMetaOf(cls);
  if (meta === undefined) return [];
  const isOwnPrompt = isSummarising(meta) && hasOwnPrompt(meta);
  const prompt = !isSummarising(meta)
    ? ""
    : isOwnPrompt
      ? await loader.load({
          label: `@Compaction "${meta.name}"`,
          options: meta,
          source: meta.source,
        })
      : builtInPromptOf(meta.strategy);
  return [
    {
      type: cls,
      name: meta.name,
      description: meta.description,
      strategy: meta.strategy,
      prompt,
      isOwnPrompt,
    },
  ];
}

/** One compaction class loaded as a workflow loads it (its prompt read); none for a non-compaction. */
export const loadedCompactionOf = async (
  cls: Class,
  loader: PromptLoader,
): Promise<LoadedCompaction | undefined> => (await loaded(cls, loader))[0];

/** A compaction's settings in the config: what a profile may change. */
function settingsOf(meta: CompactionMeta): CompactionSettings {
  // a custom one (#382): its class compacts, every `turnsBetweenCompactions` turns
  if (isCustomCompaction(meta))
    return { strategy: meta.strategy, turnsBetweenCompactions: meta.turnsBetweenCompactions };
  if (!isSummarising(meta)) return { strategy: meta.strategy };
  return {
    strategy: meta.strategy,
    // thinking off: it would spend the same `max_tokens` the summary is limited by
    model: { model: meta.model, maxTokens: meta.summaryMaxTokens, thinking: Reasoning.off() },
    turnsBetweenCompactions: meta.turnsBetweenCompactions,
    ...(meta.summaryQueueLength === undefined
      ? {}
      : { summaryQueueLength: meta.summaryQueueLength }),
  };
}

/** The config's `compactions`: each one in use, by name. */
export const compactionSettingsOf = (
  assembled: AssembledCompactions,
): Record<string, CompactionSettings> =>
  Object.fromEntries(
    assembled.compactions.flatMap((compaction) => {
      const meta = compactionMetaOf(compaction.type);
      return meta === undefined ? [] : [[compaction.name, settingsOf(meta)] as const];
    }),
  );

/** The workflow's compactions over its application's; a broken rule fails the assembly. */
export async function compactionPartsOf(
  owners: CompactionOwners,
  agents: readonly AgentMeta[],
  graph: RuntimeGraph,
  loader: PromptLoader,
): Promise<AssembledCompactions> {
  const elements = readersOf(agents, graph);
  const effective = effectiveCompactions({ ...owners, elements });
  throwIfViolated([...effective.violations, ...compactionViolations(effective.classes)]);
  const compactions = (
    await Promise.all(effective.classes.map((cls) => loaded(cls, loader)))
  ).flat();
  const nameOfClass = new Map(compactions.map((compaction) => [compaction.type, compaction.name]));
  const readers = new Map(
    elements.map((element): [string, CompactionReader] => {
      const cls = effective.byElement.get(element.name);
      const compaction = cls === undefined ? undefined : nameOfClass.get(cls);
      return [
        element.name,
        {
          ...(compaction === undefined ? {} : { compaction }),
          ...(element.uncompactedTurns === undefined
            ? {}
            : { uncompactedTurns: element.uncompactedTurns }),
        },
      ];
    }),
  );
  return { compactions, readers };
}
