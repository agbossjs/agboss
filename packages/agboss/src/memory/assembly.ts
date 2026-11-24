import type { AgentMeta } from "../components/meta-types.js";
import type { Class } from "../components/injection.js";
import { hasPrompt } from "../components/prompt-source.js";
import type { PromptLoader } from "../components/prompt-render.js";
import type { CompactionSettings } from "../config/types.js";
import { NodeKind } from "../flow/ast.js";
import { isCodeRouter } from "../flow/decorators/router.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { throwIfViolated } from "../graph/rule-error.js";
import { modelProviderOf } from "../models/model-provider.decorator.js";
import { DEFAULT_MODEL_ALIAS } from "../models/model-cascade.js";
import { TokenLimit } from "../config/types.js";
import { Reasoning } from "../models/reasoning.js";
import { SINGLE_SUMMARY_PROMPT, SUMMARY_QUEUE_PROMPT } from "../prompts/compaction.js";
import type { Milliseconds, Ttl } from "../units/index.js";
import { memoryViolations } from "./checks.js";
import {
  CUSTOM_COMPACTION,
  CompactionStrategy,
  WINDOW_ONLY,
  memoryMetaOf,
  modeOf,
  windowOf,
  type MemoryMeta,
  type MemoryMode,
  type UncompactedTurns,
} from "./memory.decorator.js";
import { effectiveMemories, type MemoryReaderElement } from "./levels.js";

/**
 * A workflow's memories as assembled (#1303): each reader's memory and window, and every memory in
 * use with its prompt read (its own, else its strategy's built-in one). The settings a profile may
 * change go to the config (`memories`, by memory name); any rule broken fails the assembly, all at once.
 */

/** One memory in use: what it summarises with. */
export interface LoadedMemory {
  readonly type: Class;
  readonly name: string;
  readonly description: string;
  readonly mode: MemoryMode;
  /** How long an idle thread is kept. */
  readonly ttl: Milliseconds | Ttl.Forever;
  /** Its prompt, read and rendered; its strategy's built-in one when it has none ("" for code and window-only). */
  readonly prompt: string;
  /** Whether `prompt` is the class's own. */
  readonly isOwnPrompt: boolean;
}

/** One reader of the thread: the memory it uses (by name) and its window. */
export interface MemoryReaderOf {
  readonly memory?: string;
  readonly uncompactedTurns?: UncompactedTurns;
}

/** A workflow's memories: every one in use and each reader's. */
export interface AssembledMemories {
  readonly memories: readonly LoadedMemory[];
  /** By agent / model router name. */
  readonly readers: ReadonlyMap<string, MemoryReaderOf>;
  /**
   * How long an idle thread of the workflow is kept: the `ttl` of the workflow's own memory (what
   * the sweep removes a thread by, #1303); absent for a stateless workflow.
   */
  readonly threadTtl?: Milliseconds | Ttl.Forever;
}

/** What the workflow sets. */
export interface MemoryOwners {
  readonly workflow: { readonly name: string; readonly memory?: Class };
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

const hasOwnPrompt = (meta: MemoryMeta): boolean => hasPrompt(meta.compaction?.prompt);

async function loaded(cls: Class, loader: PromptLoader): Promise<LoadedMemory[]> {
  const meta = memoryMetaOf(cls);
  if (meta === undefined) return [];
  const mode = modeOf(cls, meta);
  const strategy = meta.compaction?.strategy;
  const isOwnPrompt = strategy !== undefined && hasOwnPrompt(meta);
  const prompt =
    strategy === undefined
      ? ""
      : isOwnPrompt
        ? await loader.load({
            label: `@Memory "${meta.name}"`,
            options: { prompt: meta.compaction?.prompt },
            source: meta.source,
            ...(meta.compaction?.promptVariables === undefined
              ? {}
              : { variables: meta.compaction.promptVariables }),
          })
        : builtInPromptOf(strategy);
  return [
    {
      type: cls,
      name: meta.name,
      description: meta.description,
      mode,
      ttl: meta.ttl,
      prompt,
      isOwnPrompt,
    },
  ];
}

/** One memory class loaded as a workflow loads it (its prompt read); none for a non-memory. */
export const loadedMemoryOf = async (
  cls: Class,
  loader: PromptLoader,
): Promise<LoadedMemory | undefined> => (await loaded(cls, loader))[0];

/** A memory's settings in the config: what a profile may change; none for a window-only memory. */
function settingsOf(cls: Class, meta: MemoryMeta): CompactionSettings | undefined {
  const mode = modeOf(cls, meta);
  if (mode === WINDOW_ONLY) return undefined;
  // a code compaction: its class compacts, every `turnsBetweenCompactions` turns
  if (mode === CUSTOM_COMPACTION)
    return {
      strategy: CUSTOM_COMPACTION,
      turnsBetweenCompactions: meta.turnsBetweenCompactions ?? 1,
    };
  const { compaction } = meta;
  if (compaction === undefined) return undefined;
  return {
    strategy: compaction.strategy,
    // thinking off: it would spend the same `max_tokens` the summary is limited by
    model: {
      model: compaction.model ?? DEFAULT_MODEL_ALIAS,
      ...(compaction.modelProvider === undefined
        ? {}
        : { modelProvider: modelProviderOf(compaction.modelProvider).name }),
      maxTokens: compaction.summaryMaxTokens ?? TokenLimit.ModelMax,
      thinking: Reasoning.off(),
    },
    turnsBetweenCompactions: meta.turnsBetweenCompactions ?? 1,
    ...(compaction.summaryQueueLength === undefined
      ? {}
      : { summaryQueueLength: compaction.summaryQueueLength }),
  };
}

/** The config's `memories`: each memory that compacts, by name. */
export const compactionSettingsOf = (
  assembled: AssembledMemories,
): Record<string, CompactionSettings> =>
  Object.fromEntries(
    assembled.memories.flatMap((memory) => {
      const meta = memoryMetaOf(memory.type);
      const settings = meta === undefined ? undefined : settingsOf(memory.type, meta);
      return settings === undefined ? [] : [[memory.name, settings] as const];
    }),
  );

/** The workflow's memories; a broken rule fails the assembly. */
export async function memoryPartsOf(
  owners: MemoryOwners,
  agents: readonly AgentMeta[],
  graph: RuntimeGraph,
  loader: PromptLoader,
): Promise<AssembledMemories> {
  const elements = readersOf(agents, graph);
  const effective = effectiveMemories({ ...owners, elements });
  const own = owners.workflow.memory;
  // the workflow's own memory is checked even when every reader sets its own
  const checked = own === undefined ? effective.classes : [...new Set([own, ...effective.classes])];
  throwIfViolated([...effective.violations, ...memoryViolations(checked)]);
  const memories = (await Promise.all(effective.classes.map((cls) => loaded(cls, loader)))).flat();
  const nameOfClass = new Map(memories.map((memory) => [memory.type, memory.name]));
  const readers = new Map(
    elements.map((element): [string, MemoryReaderOf] => {
      const cls = effective.byElement.get(element.name);
      const memory = cls === undefined ? undefined : nameOfClass.get(cls);
      const meta = cls === undefined ? undefined : memoryMetaOf(cls);
      return [
        element.name,
        {
          ...(memory === undefined ? {} : { memory }),
          ...(meta === undefined ? {} : { uncompactedTurns: windowOf(meta) }),
        },
      ];
    }),
  );
  const ownMeta = own === undefined ? undefined : memoryMetaOf(own);
  return {
    memories,
    readers,
    ...(ownMeta === undefined ? {} : { threadTtl: ownMeta.ttl }),
  };
}
