import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { ExecutionGraph } from "../flow/runtime/build.js";
import type { AgentLoopStateType } from "../graph/agent-loop/state.js";
import type { RunServices } from "../core/run-context.js";
import type { UsageRecord } from "../finops/usage.js";

/** The `configurable` of a run: the caller's own keys, then the checkpoint thread and run services. */
export type RunConfigurable = Record<string, unknown> & { readonly thread_id: string };

/**
 * LangGraph checkpoint thread = the run id (not the conversation thread); with services, the run's
 * `RunContext` (`configurable.run`) and the services its nodes read — over the caller's `configurable`.
 */
export const runConfig = (
  runId: string,
  services?: RunServices,
  configurable: Readonly<Record<string, unknown>> = {},
): { configurable: RunConfigurable } => ({
  configurable: { ...configurable, ...services, thread_id: runId },
});

/** A run with nodes left in its checkpoint is waiting for an approval. */
export async function isWaiting(graph: ExecutionGraph, runId: string): Promise<boolean> {
  return (await graph.getState(runConfig(runId))).next.length > 0;
}

/** The agent loop a run waits in: its state so far. */
export interface PausedLoop {
  readonly state: AgentLoopStateType;
}

/** A checkpoint's state as LangGraph reads it, with its tasks (a child's own, #263). */
type Snapshot = Awaited<ReturnType<ExecutionGraph["getState"]>>;

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === "object" && value !== null && "tasks" in value && "values" in value;

/** The namespace a snapshot was read under: `""` at the root, a child's own below it. */
const namespaceOf = (snapshot: Snapshot): string => {
  const namespace: unknown = snapshot.config.configurable?.checkpoint_ns;
  return typeof namespace === "string" ? namespace : "";
};

/** Where the paused loops are read: the graph, its checkpoints, the run, the open interrupts. */
interface PausedSearch {
  readonly graph: ExecutionGraph;
  readonly checkpointer: BaseCheckpointSaver;
  readonly runId: string;
  readonly isOpen: (interruptValue: unknown) => boolean;
}

/** A checkpoint of a child execution: its state holds the child's identity (#263 S24). */
const isChildState = (values: unknown): boolean =>
  typeof values === "object" && values !== null && "child" in values && values.child !== undefined;

/** The agent loops the open interrupts of `snapshot` wait in — inside a child, the child's own. */
async function loopsIn(snapshot: Snapshot, search: PausedSearch): Promise<readonly PausedLoop[]> {
  const { checkpointer, runId, isOpen } = search;
  const tasks = snapshot.tasks.filter((candidate) =>
    candidate.interrupts.some((pending) => isOpen(pending.value)),
  );
  const parent = namespaceOf(snapshot);
  const loops = await Promise.all(
    tasks.map(async (task): Promise<readonly PausedLoop[]> => {
      // a child workflow's node (#263): its own snapshot, read with the root's; the loops are below it
      if (isSnapshot(task.state)) return loopsIn(task.state, search);
      const own = `${task.name}:${task.id}`;
      const namespace = parent === "" ? own : `${parent}|${own}`;
      const config = { configurable: { thread_id: runId, checkpoint_ns: namespace } };
      const tuple = await checkpointer.getTuple(config);
      // `ThisWorkflow` (#264): the workflow's own graph, run from the registry — read it the same way
      if (isChildState(tuple?.checkpoint.channel_values))
        return loopsIn(await search.graph.getState(config, { subgraphs: true }), search);
      // LangGraph boundary: checkpoint values are untyped; they are the agent loop's own state
      return tuple === undefined
        ? []
        : [{ state: tuple.checkpoint.channel_values as AgentLoopStateType }];
    }),
  );
  return loops.flat();
}

/**
 * The agent loops a paused run waits in — one per waiting step: parallel branches pause each in
 * their own (#267). A loop is a subgraph run inside its flow node, so its spend lives in its own
 * checkpoint — LangGraph keeps it under the namespace `<node>:<task id>` of the interrupted task —
 * until the agent node finishes. Only tasks with an open pause (`isOpen`) wait: a task that took
 * its decision and finished still lists its old interrupt until the superstep ends. A pause inside
 * a child workflow (#263) is found the same way below the child's node, at any depth.
 */
export async function pausedLoopsOf(
  graph: ExecutionGraph,
  checkpointer: BaseCheckpointSaver,
  runId: string,
  isOpen: (interruptValue: unknown) => boolean,
): Promise<readonly PausedLoop[]> {
  const snapshot = await graph.getState(runConfig(runId), { subgraphs: true });
  return loopsIn(snapshot, { graph, checkpointer, runId, isOpen });
}

/**
 * What a paused run has spent: the flow's own usage and, of every paused loop, what the loop added
 * to the usage it was handed — each branch's own spend once, all of them summed (#267).
 */
export const pausedUsageOf = (
  flowUsage: readonly UsageRecord[],
  loops: readonly PausedLoop[],
): readonly UsageRecord[] => [
  ...flowUsage,
  ...loops.flatMap((loop) => loop.state.usage.slice(loop.state.from.usage)),
];
