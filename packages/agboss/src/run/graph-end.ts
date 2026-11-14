import type { ExecutionGraph } from "../flow/runtime/build.js";

/** What a checkpoint's snapshot says of the graph: the tasks it still has to run. */
export type GraphSnapshot = Pick<Awaited<ReturnType<ExecutionGraph["getState"]>>, "tasks">;

/**
 * Whether the graph reached its end at the snapshot's checkpoint (#1090): no node is left to run
 * there — LangGraph's own terminal condition (its loop is done when the checkpoint triggers no
 * task). `next` alone is not that: `getState` without a checkpoint id applies the pending writes of
 * the checkpoint's tasks, and a task whose writes are saved is left out of `next` — the list is
 * empty although the graph has not finished (its holder lost the tree between the task's writes and
 * the next checkpoint). `tasks` lists every task of the checkpoint, the ones with saved writes too:
 * a graph with a task left, whatever it has saved, runs on (`stream(null)` applies the saved
 * writes, runs the rest, and writes the checkpoint after them).
 */
export const hasGraphEnded = (snapshot: GraphSnapshot): boolean => snapshot.tasks.length === 0;
