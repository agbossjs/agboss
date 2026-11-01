import type { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { BaseCheckpointSaver, emptyCheckpoint } from "@langchain/langgraph";
import type { ChildIdentityRecord } from "./child-records.js";
import type { ExecutionStateType } from "./state.js";

/**
 * A child execution's own checkpoint thread (ADR-0022, #333 PR 1): `<parentThreadId>/child/<id>` on
 * the application's checkpointer — never a thread of the API. The child's graph runs there as a
 * root graph, outside its parent's LangGraph run (its namespace, task and resume map), so its
 * checkpoints, interrupts and resumes are its own. The parent's launching task keeps a **marker**
 * at its `checkpoint_ns` on the parent's thread — the child's identity and thread — where a re-entry
 * after a pause or a crash finds it (the place that held the child's whole state before, #263 S24).
 */

/** The child's own checkpoint thread (S4 D3). */
export const childThreadOf = (parentThreadId: string, executionId: string): string =>
  `${parentThreadId}/child/${executionId}`;

/** What the launching task's marker holds: the child's identity and its own thread. */
export interface ChildMarker {
  readonly child: ChildIdentityRecord;
  readonly childThread: string;
}

/** LangGraph's own keys of a node's config: the parent's run, never the child's. */
const isLangGraphKey = (key: string): boolean =>
  key.startsWith("__pregel") || key.startsWith("checkpoint_") || key === "thread_id";

/** A config's `configurable` without LangGraph's keys: the framework's run and services only. */
const ownConfigurable = (config: RunnableConfig | undefined): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(config?.configurable ?? {}).filter(([key]) => !isLangGraphKey(key)),
  );

/** Metadata without LangGraph's (`langgraph_*`, `checkpoint_ns`): the child's run is a root. */
const ownMetadata = (config: RunnableConfig | undefined): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(config?.metadata ?? {}).filter(
      ([key]) => !key.startsWith("langgraph_") && !key.startsWith("checkpoint_"),
    ),
  );

/** The child's config on its own thread: the framework's run over the child's checkpoint thread. */
export function rootConfigOf(config: RunnableConfig, childThread: string): RunnableConfig {
  return {
    ...config,
    metadata: ownMetadata(config),
    configurable: { ...ownConfigurable(config), thread_id: childThread },
  };
}

/** Runs `body` outside the parent's LangGraph run: the child's graph is a root of its own. */
export const asRootRun = <T>(body: () => Promise<T>): Promise<T> =>
  AsyncLocalStorageProviderSingleton.getInstance().run(undefined, body);

/** Whether a streamed value or a snapshot's values are a child's execution state. */
export const isExecutionState = (value: unknown): value is ExecutionStateType =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { usage?: unknown }).usage);

/** Where the launching task's marker is kept: the parent's thread, the task's namespace. */
export function markerConfigOf(config: RunnableConfig | undefined): RunnableConfig | undefined {
  const threadId: unknown = config?.configurable?.thread_id;
  const namespace: unknown = config?.configurable?.checkpoint_ns;
  if (typeof threadId !== "string" || typeof namespace !== "string") return undefined;
  return { configurable: { thread_id: threadId, checkpoint_ns: namespace } };
}

/** Keeps the launching task's marker: written once, on the child's first entry. */
export async function saveChildMarker(
  checkpointer: BaseCheckpointSaver,
  at: RunnableConfig,
  marker: ChildMarker,
): Promise<void> {
  const checkpoint = emptyCheckpoint();
  const values = { child: marker.child, childThread: marker.childThread };
  const versions = Object.fromEntries(Object.keys(values).map((channel) => [channel, 1]));
  await checkpointer.put(
    at,
    { ...checkpoint, channel_values: values, channel_versions: versions },
    { source: "update", step: -1, parents: {} },
    versions,
  );
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** The child's thread a checkpoint's values name: a marker's; `undefined` for anything else. */
export const childThreadIn = (values: unknown): string | undefined =>
  isRecord(values) && typeof values.childThread === "string" ? values.childThread : undefined;

/** What a waiting parent's node interrupts with (`child-own-thread.ts`): where its child is. */
export interface WaitingFor {
  readonly thread: string;
  /** The parent's node: the child's graph is its registered subgraph (or `ThisWorkflow`'s own). */
  readonly node: string;
  readonly isRecursive: boolean;
  /** Whether the child runs on any instance through `ChildExecutionQueueRepository` (#333 PR 4). */
  readonly remote?: boolean | undefined;
}

/** A waiting marker read back from an interrupt's value; `undefined` for anything else (a pause). */
export function waitingForOf(value: unknown): WaitingFor | undefined {
  if (!isRecord(value) || !isRecord(value.waitingForChild)) return undefined;
  const { thread, node, isRecursive, remote } = value.waitingForChild;
  if (typeof thread !== "string" || typeof node !== "string" || typeof isRecursive !== "boolean")
    return undefined;
  return {
    thread,
    node,
    isRecursive,
    ...(typeof remote === "boolean" ? { remote } : {}),
  };
}

/** A graph that registers its children's graphs on their nodes (Studio's drawing, ADR-0022). */
interface WithSubgraphs {
  getSubgraphsAsync(namespace?: string): AsyncIterableIterator<[string, unknown]>;
}

/** The graph a waiting marker's child runs: its node's registered subgraph, or the graph itself. */
export async function childGraphOf<G extends WithSubgraphs>(
  graph: G,
  waiting: WaitingFor,
): Promise<G | undefined> {
  if (waiting.isRecursive) return graph;
  for await (const [name, subgraph] of graph.getSubgraphsAsync(waiting.node))
    // LangGraph boundary: a node's registered subgraph is the child's compiled graph (same kind)
    if (name === waiting.node) return subgraph as G;
  return undefined;
}

/**
 * The checkpoint a run wrote last (#661), where its end is read — never a thread's latest. LangGraph
 * names each checkpoint by a UUIDv6 of `Date.now()` and a saver's latest checkpoint is the one with
 * the greatest id, so after the host's wall clock steps back (an NTP `settimeofday`) a run's newest
 * checkpoints sort before older ones: its thread's latest is then a checkpoint whose tasks all wrote
 * — `next` empty, read as ended — with none of their values (a child's result lost). A run streamed
 * with `WRITTEN_MODES` names each checkpoint it writes; `checkpointAt` reads that one by its id.
 */

/** The stream modes of a run whose checkpoints are read back: its states and its checkpoints. */
export const WRITTEN_MODES: ["values", "checkpoints"] = ["values", "checkpoints"];

/** The id of the checkpoint a run wrote last, filled while it streams. */
export interface WrittenCheckpoint {
  id?: string;
}

/** A streamed checkpoint's id (LangGraph's `checkpoints` stream mode: checked, not cast). */
function checkpointIdOf(payload: unknown): string | undefined {
  const config: unknown = isRecord(payload) ? payload.config : undefined;
  const configurable: unknown = isRecord(config) ? config.configurable : undefined;
  const id: unknown = isRecord(configurable) ? configurable.checkpoint_id : undefined;
  return typeof id === "string" ? id : undefined;
}

/** The values chunks of a `WRITTEN_MODES` stream; the id of each checkpoint chunk kept in `written`. */
export async function* valuesWritten<TValues>(
  chunks: AsyncIterable<readonly ["values", TValues] | readonly ["checkpoints", unknown]>,
  written: WrittenCheckpoint,
): AsyncGenerator<TValues> {
  for await (const chunk of chunks) {
    if (chunk[0] === "values") yield chunk[1];
    else written.id = checkpointIdOf(chunk[1]) ?? written.id;
  }
}

/** `config` at the checkpoint the run wrote last; the thread's latest when it wrote none. */
export const checkpointAt = (config: RunnableConfig, written: WrittenCheckpoint): RunnableConfig =>
  written.id === undefined
    ? config
    : { ...config, configurable: { ...config.configurable, checkpoint_id: written.id } };

/**
 * `config` at the leaf of its thread's checkpoint chain — the one checkpoint no other names as its
 * parent: what a reader that did not stream the run (a remote child's parent) reads instead of the
 * greatest id; the thread's latest when there is no single leaf (no checkpoint, or a fork).
 */
export async function atLeafCheckpoint(
  saver: BaseCheckpointSaver | boolean | undefined,
  config: RunnableConfig,
): Promise<RunnableConfig> {
  if (!(saver instanceof BaseCheckpointSaver)) return config;
  const ids = new Set<string>();
  const parents = new Set<string>();
  const threadId: unknown = config.configurable?.thread_id;
  const namespace: unknown = config.configurable?.checkpoint_ns ?? "";
  const thread = { configurable: { thread_id: threadId, checkpoint_ns: namespace } };
  for await (const tuple of saver.list(thread)) {
    ids.add(tuple.checkpoint.id);
    const parent: unknown = tuple.parentConfig?.configurable?.checkpoint_id;
    if (typeof parent === "string") parents.add(parent);
  }
  const leaves = [...ids].filter((id) => !parents.has(id));
  return leaves.length === 1 ? checkpointAt(config, { id: leaves[0] }) : config;
}
