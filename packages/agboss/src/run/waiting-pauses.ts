import { z } from "zod";
import type { ExecutionGraph } from "../flow/runtime/build.js";
import {
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../infrastructure/paused-execution.repository.js";
import type { WaitingPause } from "../pause/index.js";
import { runConfig } from "./paused.js";

/**
 * Where an execution waits (#267 AC1): every `interrupt()` of its pending superstep — a paused
 * branch does not stop its siblings, so the execution rests only when nothing else can move, with
 * one interrupt per waiting step — and the pause record each one carries.
 */

/** One interrupt of the pending superstep: LangGraph's id and the pause it is. */
export interface WaitingInterrupt {
  readonly interruptId: string;
  readonly pauseId: string;
}

/** What the pause step puts in an interrupt (`pause.ts`), read back at the LangGraph boundary. */
const PauseInterrupt = z.object({ pauseId: z.string() });

/** Every interrupt of the execution's pending superstep that carries a pause, each once. */
export async function waitingInterruptsOf(
  graph: ExecutionGraph,
  runId: string,
): Promise<readonly WaitingInterrupt[]> {
  const snapshot = await graph.getState(runConfig(runId));
  const found = new Map<string, WaitingInterrupt>();
  for (const { id, value } of snapshot.tasks.flatMap((task) => task.interrupts)) {
    const carried = PauseInterrupt.safeParse(value);
    if (id !== undefined && carried.success)
      found.set(id, { interruptId: id, pauseId: carried.data.pauseId });
  }
  return [...found.values()];
}

/** A pause record as the execution's result lists it. */
const waitingPauseOf = (pause: PauseRecord): WaitingPause => ({
  pauseId: pause.pauseId,
  answeredBy: pause.answeredBy,
  agent: pause.agent,
  channel: pause.channel,
  childExecutionId: pause.executionId === pause.rootExecutionId ? undefined : pause.executionId,
  itemIndex: pause.itemIndex,
  ask: pause.ask,
});

/** What the execution's tree waits for: the pending pauses its interrupts carry, in their order. */
export async function waitingPausesOf(
  graph: ExecutionGraph,
  pauses: PausedExecutionRepository,
  tree: { readonly tenantId: string; readonly runId: string },
): Promise<readonly WaitingPause[]> {
  const interrupts = await waitingInterruptsOf(graph, tree.runId);
  const records = await pauses.findAllByTenantIdAndRootExecutionId(tree.tenantId, tree.runId);
  const byId = new Map(records.map((record) => [record.pauseId, record]));
  return interrupts.flatMap(({ pauseId }) => {
    const pause = byId.get(pauseId);
    return pause?.status === PauseStatus.Pending ? [waitingPauseOf(pause)] : [];
  });
}
