import type { Task } from "@a2a-js/sdk";
import { seconds, type Milliseconds } from "../../units/index.js";
import { A2AClientOperation } from "./a2a-client-errors.js";
import { isSettled } from "./a2a-outcome.js";
import { Waiter, type TaskWait } from "./a2a-waiter.js";
import { isEndedAtSubscribe, isTransientWireError, wireErrorOf } from "./a2a-wire-errors.js";

export type { TaskWait } from "./a2a-waiter.js";

/**
 * Waiting for a remote task (#809, design §4.2 "Waiting"): a pure read, safe to repeat after any
 * crash — `SubscribeToTask` when the card streams, re-opened when the stream drops, else `GetTask`
 * polled on the application's `Clock` (250 ms doubling to 5 s). It ends at a terminal or
 * interrupted state; a task that works — a pause answered out of band included — is waited for up
 * to the deadline (`Waiter`: a best-effort `CancelTask`, `A2ACallDeadlineError`). The caller's
 * signal ends it with its own reason and cancels nothing: a lost lease hands the call over, and the
 * next holder waits on the same task. Only what the agent answers is judged — one rule for the
 * stream and the poll (`isTransientWireError`); a malformed event or the caller's own `onEvent`
 * failing ends the wait as it is.
 */

export const FIRST_POLL = seconds(0.25);
export const LAST_POLL = seconds(5);
/** Streams that drop in a row before the wait polls instead. */
export const MAX_STREAM_DROPS = 3;
/** Polls that fail in a row (no answer, 5xx) before the wait gives up with the last error. */
export const MAX_POLL_FAILURES = 5;

/** What one wire read gave: its value, or the failure the agent answered (translated). */
type Read<T> = { readonly value: T } | { readonly failure: unknown };

/** One wire read: its value, or what failed translated — the wait's abort read apart. */
async function read<T>(
  waiter: Waiter,
  operation: A2AClientOperation,
  wire: () => Promise<T>,
): Promise<Read<T>> {
  try {
    return { value: await Promise.race([wire(), waiter.abortedPromise()]) };
  } catch (error) {
    if (waiter.signal.aborted) return waiter.aborted();
    return { failure: wireErrorOf(error, waiter.wait.agent, operation) };
  }
}

/**
 * One stream of the task, to its end: the settled task, `"dropped"` when it ended or dropped
 * early, `"ended"` when the agent says the task ended before it subscribed. Each event is awaited
 * against the wait's signal — a transport that does not abort its stream cannot hold the wait past
 * its deadline — and taken outside the wire's judgement.
 */
async function streamOnce(waiter: Waiter): Promise<Task | "dropped" | "ended"> {
  const { client, taskId } = waiter.wait;
  const events = client.resubscribeTask({ tenant: "", id: taskId }, { signal: waiter.signal });
  try {
    for (;;) {
      const next = await read(waiter, A2AClientOperation.SubscribeToTask, () => events.next());
      if ("failure" in next) {
        if (isEndedAtSubscribe(next.failure)) return "ended";
        if (isTransientWireError(next.failure)) return "dropped";
        throw next.failure;
      }
      if (next.value.done === true) return "dropped";
      const settled = waiter.take(next.value.value);
      if (settled !== undefined) return settled;
    }
  } finally {
    void events.return(undefined).catch(() => undefined);
  }
}

/** Streams until settled; `undefined` once it should poll instead (drops, or ended at subscribe). */
async function streamed(waiter: Waiter): Promise<Task | undefined> {
  for (let drops = 0; drops < MAX_STREAM_DROPS; drops += 1) {
    const outcome = await streamOnce(waiter);
    if (outcome === "ended") return undefined; // GetTask reads how it ended
    if (outcome !== "dropped") return outcome;
  }
  return undefined;
}

/** One poll's judgement: the settled task, or `undefined` to go on (a transient failure counted). */
async function pollOnce(waiter: Waiter, failures: { count: number }): Promise<Task | undefined> {
  const { client, taskId } = waiter.wait;
  const polledTask = await read(waiter, A2AClientOperation.GetTask, () =>
    client.getTask({ tenant: "", id: taskId }, { signal: waiter.signal }),
  );
  if ("value" in polledTask) {
    failures.count = 0;
    return waiter.took(polledTask.value);
  }
  failures.count += 1;
  if (!isTransientWireError(polledTask.failure) || failures.count >= MAX_POLL_FAILURES) {
    throw polledTask.failure;
  }
  return undefined;
}

/** Polls until settled, on the `Clock`, backing off; a few transient failures in a row end it. */
async function polled(waiter: Waiter): Promise<Task> {
  const failures = { count: 0 };
  for (
    let delay: Milliseconds = FIRST_POLL;
    ;
    delay = Math.min(LAST_POLL, delay * 2) as Milliseconds
  ) {
    const settled = await pollOnce(waiter, failures);
    if (settled !== undefined) return settled;
    // the Clock's sleep ends early, without an error, when the signal aborts
    await waiter.wait.clock.sleep(delay, waiter.signal);
    if (waiter.signal.aborted) return waiter.aborted();
  }
}

/** Waits for the task to settle (terminal or interrupted): see the module's comment. */
export async function waitForTask(wait: TaskWait): Promise<Task> {
  if (wait.task !== undefined && isSettled(wait.task)) return wait.task;
  const waiter = new Waiter(wait);
  try {
    if (waiter.signal.aborted) return await waiter.aborted();
    waiter.armDeadline();
    const settled = wait.isStreaming ? await streamed(waiter) : undefined;
    return settled ?? (await polled(waiter));
  } finally {
    waiter.close();
  }
}
