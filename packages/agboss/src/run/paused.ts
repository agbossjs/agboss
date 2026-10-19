import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { ExecutionGraph } from "../flow/runtime/build.js";
import type { AgentLoopStateType } from "../graph/agent-loop/state.js";
import type { RunServices } from "../core/run-context.js";

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

/**
 * The agent loop a paused run waits in. The loop is a subgraph run inside its flow node, so its
 * spend lives in its own checkpoint — LangGraph keeps it under the namespace `<node>:<task id>` of
 * the interrupted task — until the agent node finishes.
 */
export async function pausedLoopOf(
  graph: ExecutionGraph,
  checkpointer: BaseCheckpointSaver,
  runId: string,
): Promise<PausedLoop | undefined> {
  const snapshot = await graph.getState(runConfig(runId));
  const task = snapshot.tasks.find((candidate) => candidate.interrupts.length > 0);
  if (task === undefined) return undefined;
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: runId, checkpoint_ns: `${task.name}:${task.id}` },
  });
  if (tuple === undefined) return undefined;
  // LangGraph boundary: checkpoint values are untyped; they are the agent loop's own state
  const state = tuple.checkpoint.channel_values as AgentLoopStateType;
  return { state };
}
