import {
  A2ATaskState,
  isTerminalA2ATaskState,
  type A2ATaskRecord,
} from "../../infrastructure/a2a-task.repository.js";
import { nextChange } from "./a2a-local-runs.js";
import { repairedOf, taskKeyOf, type A2AServerParts } from "./a2a-server-parts.js";
import { taskNotFound } from "./a2a-wire-errors.js";

/**
 * Waiting for a task (#808, design §4.1.3 step 8): read again at each change in this process, at
 * the end of its run here and every `TASK_POLL` on the clock — repaired from its records as reads
 * are, and at once when its run here ended (the projection's write may be the one event lost). The
 * wait ends with the request's signal; the task never does.
 */

/**
 * Whether a blocking send stops waiting: the task is over, or waits for its caller (§3.1.1) — after
 * `answered`, the version a follow-up's answer found: the wait it answered is not a rest again.
 */
export const isAtRest = (task: A2ATaskRecord, answered = 0): boolean =>
  isTerminalA2ATaskState(task.status.state) ||
  (task.status.state === A2ATaskState.InputRequired && task.version > answered);

/** The task as read after its next change (its run here ended: checked against its records now). */
export async function changedTask(
  parts: A2AServerParts,
  task: A2ATaskRecord,
  signal: AbortSignal,
): Promise<A2ATaskRecord> {
  const key = taskKeyOf(task);
  const local = parts.runs.settledOf(key);
  let isEnded = false;
  void local?.then(() => {
    isEnded = true;
  });
  await nextChange(parts, key, signal);
  const read = await parts.tasks.findById(key);
  // swept while waited for (over and past its retention): no more
  if (read === undefined) throw taskNotFound();
  return repairedOf(parts, read, isEnded);
}

/** The task once at rest (`answered`: as `isAtRest`), or as it is when `signal` aborts. */
export async function restingTask(
  parts: A2AServerParts,
  task: A2ATaskRecord,
  signal: AbortSignal,
  answered = 0,
): Promise<A2ATaskRecord> {
  let current = task;
  while (!isAtRest(current, answered) && !signal.aborted)
    current = await changedTask(parts, current, signal);
  return current;
}
