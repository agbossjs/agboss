import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, interrupt, isGraphInterrupt } from "@langchain/langgraph";
import type { ExecutionGraph } from "./build.js";
import type { ChildGraph } from "./child.js";
import type { ChildEntered } from "./child-identity.js";
import { asRootRun, isExecutionState, rootConfigOf } from "./child-thread.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "./state.js";

/**
 * A child execution on its own thread (ADR-0022, #333 PR 1), awaited inside its parent's step
 * (S4 D2, the hybrid): its graph runs as a root graph on `<parentThreadId>/child/<id>` until it
 * ends — the parent goes on in the same pass, as before — or rests at a pause. A resting child
 * makes its parent's node interrupt with a **waiting marker** (`ChildWaiting`, never a pause: it
 * carries no `pauseId`); the tree rests as for any pause. A resume is one command for the tree: the
 * drain gives the marker the child's own resume map (`waiting-pauses.ts`), which the node forwards
 * to the child's thread on its next run; the child's end lets the parent go on.
 */

/** What a waiting marker says: the child it waits for and where its state is. */
export interface ChildWaiting {
  readonly waitingForChild: {
    readonly executionId: string;
    readonly thread: string;
    /** The parent's node: the child's graph is its registered subgraph (or `ThisWorkflow`'s own). */
    readonly node: string;
    readonly isRecursive: boolean;
    /** Whether the child runs on any instance through `ChildExecutionQueueRepository` (#333 PR 4). */
    readonly remote?: boolean | undefined;
  };
}

/** A child's run on its own thread: its graph, its first state, its config, whether it is new. */
export interface OwnThreadRun {
  readonly graph: ExecutionGraph;
  /** The failure an earlier pass claimed (#596): repeated at once while the child has not ended. */
  readonly claimed?: unknown;
  readonly thread: string;
  readonly initial: ExecutionStateUpdate;
  readonly config: RunnableConfig;
  readonly isNew: boolean;
  readonly waiting: ChildWaiting;
}

/** How a child's run on its own thread ended in this step. */
export type OwnThreadEnd =
  | {
      readonly kind: "ended";
      readonly state: ExecutionStateType;
      /** This call streamed the child to its end (#562): else it had ended before, only read. */
      readonly isOwn: boolean;
    }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      readonly last?: ExecutionStateType;
      /**
       * The child had failed before this call (#562): an errored task on its thread at entry — an
       * earlier pass saw that failure; this call ran the step again and only repeats it.
       */
      readonly isRepeated: boolean;
    };

/** A forwarded resume map, read from the marker's answer (the drain wrote it as JSON). */
export function resumeMapOf(answer: unknown): Readonly<Record<string, string>> {
  if (typeof answer !== "string") return {};
  const parsed: unknown = JSON.parse(answer);
  if (typeof parsed !== "object" || parsed === null) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** The child's last state streamed so far: kept when the child throws, for its record. */
interface Streamed {
  last?: ExecutionStateType;
  /** This call streamed the child's graph at least once (#562). */
  isStreamed?: boolean;
}

/** Streams the child's graph on its own thread, as a root graph, into `seen`. */
async function stream(
  run: OwnThreadRun,
  config: RunnableConfig,
  input: ExecutionStateUpdate | Command | null,
  seen: Streamed,
): Promise<void> {
  seen.isStreamed = true;
  await asRootRun(async () => {
    const states = await run.graph.stream(input, { ...config, streamMode: "values" });
    for await (const state of states) if (isExecutionState(state)) seen.last = state;
  });
}

/** The child's state on its own thread, and whether it rests (tasks left with an interrupt). */
async function snapshotOf(run: OwnThreadRun, config: RunnableConfig) {
  const snapshot = await run.graph.getState(config);
  const interrupts = snapshot.tasks.flatMap((task) =>
    task.interrupts.flatMap((each) => (each.id === undefined ? [] : [each.id])),
  );
  return { snapshot, rests: snapshot.next.length > 0, interrupts };
}

/**
 * A re-entered child as an earlier pass left it: whether a task failed (its error in the
 * checkpoint), and whether it still rests — not ended, so a claimed failure (#596) is its end.
 */
async function reenteredOf(
  run: OwnThreadRun,
  config: RunnableConfig,
): Promise<{ readonly hasFailed: boolean; readonly rests: boolean }> {
  const { snapshot, rests } = await snapshotOf(run, config);
  return { hasFailed: snapshot.tasks.some((task) => task.error !== undefined), rests };
}

/**
 * One look at the child: its final state when it ended; else it is moved on — continued after a
 * crash, or, while it rests at a pause, the parent waits (the marker's interrupt) and on its next
 * run forwards the child's answers.
 */
async function movedOn(
  run: OwnThreadRun,
  config: RunnableConfig,
  seen: Streamed,
): Promise<ExecutionStateType | undefined> {
  const { snapshot, rests, interrupts } = await snapshotOf(run, config);
  if (!rests) {
    const state = isExecutionState(snapshot.values) ? snapshot.values : seen.last;
    if (state === undefined) throw new TypeError(`${run.thread} ended without a state`);
    return state;
  }
  // stopped mid-step (a crash, a lost lease): the child goes on from its last checkpoint
  if (interrupts.length === 0) {
    await stream(run, config, null, seen);
    return undefined;
  }
  const answer: unknown = interrupt(run.waiting);
  const resume = resumeMapOf(answer);
  // an answer of an earlier wait of this node (replayed by LangGraph): the child is past it
  if (interrupts.some((id) => id in resume))
    await stream(run, config, new Command({ resume }), seen);
  return undefined;
}

/**
 * The child run to its end in this step, or its parent's node interrupted with the waiting marker
 * while it rests (thrown by `interrupt()`: the parent's own pause). A re-entry continues it from
 * its own checkpoint — never from its first state again.
 */
export async function runOnOwnThread(run: OwnThreadRun): Promise<OwnThreadEnd> {
  const config = rootConfigOf(run.config, run.thread);
  const seen: Streamed = {};
  let isRepeated = false;
  try {
    if (run.isNew) await stream(run, config, run.initial, seen);
    else {
      const reentered = await reenteredOf(run, config);
      isRepeated = reentered.hasFailed;
      // a finish on its thread is its end; else a claimed failure is (#596), its step not run again
      if (run.claimed !== undefined && reentered.rests)
        return { kind: "failed", error: run.claimed, isRepeated: true };
    }
    for (;;) {
      const ended = await movedOn(run, config, seen);
      if (ended !== undefined)
        return { kind: "ended", state: ended, isOwn: seen.isStreamed === true };
    }
  } catch (error) {
    // the parent's own interrupt (the marker) rises as it is, never as the child's failure
    if (isGraphInterrupt(error)) throw error;
    const last = seen.last === undefined ? {} : { last: seen.last };
    return { kind: "failed", error, ...last, isRepeated };
  }
}

/** What a child's end needs of its entry: its first state, its config, its identity and node. */
export interface ChildEndRun {
  readonly initial: ExecutionStateUpdate;
  /** The failure an earlier pass claimed (#596). */
  readonly claimed?: unknown;
  readonly config: RunnableConfig;
  readonly entered: ChildEntered;
  readonly node: string;
}

/** The child's graph run to its end: on its own thread (ADR-0022), or an old child's subgraph way. */
export async function childEndOf(
  child: Pick<ChildGraph, "graph" | "isRecursive">,
  run: ChildEndRun,
): Promise<{
  readonly state?: ExecutionStateType;
  readonly error?: unknown;
  readonly failed: boolean;
  /** Whether this pass announces the child's end (#562, `assertAnnouncing`, `child-failure.ts`). */
  readonly announces: boolean;
}> {
  const { thread, isNew, identity } = run.entered;
  if (thread !== undefined) {
    const waiting = {
      waitingForChild: {
        executionId: identity.executionId,
        thread,
        node: run.node,
        isRecursive: child.isRecursive,
      },
    };
    const end = await runOnOwnThread({
      graph: child.graph,
      thread,
      initial: run.initial,
      config: run.config,
      isNew,
      waiting,
      claimed: run.claimed,
    });
    if (end.kind === "ended") return { state: end.state, failed: false, announces: end.isOwn };
    // a failure an earlier pass saw is not announced again when the re-run step fails again
    const last = end.last === undefined ? {} : { state: end.last };
    return { error: end.error, ...last, failed: true, announces: !end.isRepeated };
  }
  // started before ADR-0022 (S4 D6): its state is the subgraph checkpoint under its task
  let last: ExecutionStateType | undefined;
  try {
    const states = await child.graph.stream(run.initial, { ...run.config, streamMode: "values" });
    for await (const state of states) if (Array.isArray(state.usage)) last = state;
  } catch (error) {
    return { error, ...(last === undefined ? {} : { state: last }), failed: true, announces: true };
  }
  return last === undefined
    ? { failed: false, announces: true }
    : { state: last, failed: false, announces: true };
}
