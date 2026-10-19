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

/**
 * The agent loops a paused run waits in — one per waiting step: parallel branches pause each in
 * their own (#267). A loop is a subgraph run inside its flow node, so its spend lives in its own
 * checkpoint — LangGraph keeps it under the namespace `<node>:<task id>` of the interrupted task —
 * until the agent node finishes. Only tasks with an open pause (`isOpen`) wait: a task that took
 * its decision and finished still lists its old interrupt until the superstep ends.
 */
export async function pausedLoopsOf(
  graph: ExecutionGraph,
  checkpointer: BaseCheckpointSaver,
  runId: string,
  isOpen: (interruptValue: unknown) => boolean,
): Promise<readonly PausedLoop[]> {
  const snapshot = await graph.getState(runConfig(runId));
  const tasks = snapshot.tasks.filter((candidate) =>
    candidate.interrupts.some((pending) => isOpen(pending.value)),
  );
  const loops = await Promise.all(
    tasks.map(async (task) => {
      const tuple = await checkpointer.getTuple({
        configurable: { thread_id: runId, checkpoint_ns: `${task.name}:${task.id}` },
      });
      // LangGraph boundary: checkpoint values are untyped; they are the agent loop's own state
      return tuple === undefined
        ? []
        : [{ state: tuple.checkpoint.channel_values as AgentLoopStateType }];
    }),
  );
  return loops.flat();
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
