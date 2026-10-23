import { z } from "zod";
import type { ExecutionGraph } from "../flow/runtime/build.js";
import {
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../infrastructure/paused-execution.repository.js";
import type { WaitingPause } from "../pause/index.js";
import { runConfig } from "./paused.js";
import { childGraphOf, waitingForOf } from "../flow/runtime/child-thread.js";

/**
 * Where an execution waits (#267 AC1): every `interrupt()` of its pending superstep — a paused
 * branch does not stop its siblings, so the execution rests only when nothing else can move, with
 * one interrupt per waiting step — and the pause record each one carries.
 */

/** One interrupt of the pending superstep: LangGraph's id and the pause it is. */
export interface WaitingInterrupt {
  readonly interruptId: string;
  readonly pauseId: string;
  /**
   * The waiting markers above it (ADR-0022): the interrupt ids, from the root's down, of the
   * parents' nodes that wait for the child it is in — empty for a pause of the tree's own thread
   * (a child of the old layout too: its interrupt is the root's).
   */
  readonly via: readonly string[];
}

/** What the pause step puts in an interrupt (`pause.ts`), read back at the LangGraph boundary. */
const PauseInterrupt = z.object({ pauseId: z.string() });

/** Every pause interrupt of one thread's pending superstep, a waiting marker followed to its child. */
async function interruptsIn(
  graph: ExecutionGraph,
  threadId: string,
  via: readonly string[],
  found: Map<string, WaitingInterrupt>,
): Promise<void> {
  const snapshot = await graph.getState(runConfig(threadId));
  for (const { id, value } of snapshot.tasks.flatMap((task) => task.interrupts)) {
    if (id === undefined) continue;
    const carried = PauseInterrupt.safeParse(value);
    if (carried.success) {
      found.set(id, { interruptId: id, pauseId: carried.data.pauseId, via });
      continue;
    }
    const waiting = waitingForOf(value);
    const child = waiting === undefined ? undefined : await childGraphOf(graph, waiting);
    if (waiting !== undefined && child !== undefined)
      await interruptsIn(child, waiting.thread, [...via, id], found);
  }
}

/**
 * Every interrupt of the execution's pending superstep that carries a pause, each once — and, below
 * a waiting marker, every one of the child's own thread (ADR-0022), at any depth.
 */
export async function waitingInterruptsOf(
  graph: ExecutionGraph,
  runId: string,
): Promise<readonly WaitingInterrupt[]> {
  const found = new Map<string, WaitingInterrupt>();
  await interruptsIn(graph, runId, [], found);
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

/** Which pauses a pass has handled: those it took, those it is about to answer or withdraw. */
export interface PassPauses {
  /** The resolved pauses the pass took: their loops went on. */
  readonly taken?: ReadonlySet<string>;
  /** The pauses the pass is about to answer or withdraw: their loops still wait at them. */
  readonly answering?: ReadonlySet<string>;
}

/** A pause its loop still waits in: no decision yet, one recorded that no pass took, or answered now. */
const isOpenPause = (record: PauseRecord, pass: PassPauses): boolean =>
  record.status === PauseStatus.Pending ||
  (record.status === PauseStatus.Resolved && pass.taken?.has(record.pauseId) !== true) ||
  pass.answering?.has(record.pauseId) === true;

/**
 * Whether an interrupt's value is a pause its loop still waits in. LangGraph lists a task's
 * interrupts until its superstep ends, so a branch that took its decision in this pass (`taken`:
 * `Taken` only once the pass returned) still shows its old interrupt — its loop went on, and what
 * it spent is the flow's or its new pause's.
 */
export async function openPausesOf(
  pauses: PausedExecutionRepository,
  tree: { readonly tenantId: string; readonly runId: string },
  pass: PassPauses = {},
): Promise<(interruptValue: unknown) => boolean> {
  const records = await pauses.findAllByTenantIdAndRootExecutionId(tree.tenantId, tree.runId);
  const open = new Set(
    records.filter((record) => isOpenPause(record, pass)).map((record) => record.pauseId),
  );
  return (interruptValue) => {
    const carried = PauseInterrupt.safeParse(interruptValue);
    return carried.success && open.has(carried.data.pauseId);
  };
}
