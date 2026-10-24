import type { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { emptyCheckpoint, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { ChildIdentityRecord } from "./child-records.js";

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
}

/** A waiting marker read back from an interrupt's value; `undefined` for anything else (a pause). */
export function waitingForOf(value: unknown): WaitingFor | undefined {
  if (!isRecord(value) || !isRecord(value.waitingForChild)) return undefined;
  const { thread, node, isRecursive } = value.waitingForChild;
  return typeof thread === "string" && typeof node === "string" && typeof isRecursive === "boolean"
    ? { thread, node, isRecursive }
    : undefined;
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
