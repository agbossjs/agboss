import { TaskState, type StreamResponse, type Task } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import type { Clock } from "../../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import { isSettled, stateOf } from "./a2a-outcome.js";
import { checkedTask, updatedTask } from "./a2a-task-view.js";
import { A2ACallDeadlineError, A2ACancelOutcome, safeTaskIdOf } from "./a2a-task-errors.js";

/**
 * One wait for a remote task in progress (#809): its own signal — the caller's, and the
 * deadline's on the `Clock` — the task as its events and reads change it, and at the deadline the
 * best-effort cancel and `A2ACallDeadlineError`.
 */

/** What one wait needs. */
export interface TaskWait {
  readonly agent: string;
  readonly client: Pick<Client, "getTask" | "resubscribeTask" | "cancelTask">;
  readonly clock: Pick<Clock, "now" | "sleep">;
  readonly taskId: string;
  /** The task as last seen (the accept's answer), if any. */
  readonly task: Task | undefined;
  readonly isStreaming: boolean;
  /** When the wait ends at the latest: the execution's deadline or the call's own. */
  readonly deadlineAt: Date | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onEvent: ((event: StreamResponse) => void) | undefined;
}

/** How long the best-effort cancel at the deadline may take. */
export const CANCEL_TIMEOUT = seconds(5);

/** The reason a wait's own signal is aborted with at its deadline. */
class DeadlineReached extends Error {}

/** How a cancel went, and the task it answered. */
interface Canceled {
  readonly outcome: A2ACancelOutcome;
  readonly task?: Task;
}

export class Waiter {
  readonly wait: TaskWait;
  readonly #controller = new AbortController();
  readonly #forward: () => void;
  #task: Task | undefined;

  constructor(wait: TaskWait) {
    this.wait = wait;
    this.#task = wait.task;
    const { signal } = wait;
    this.#forward = () => {
      this.#controller.abort(signal?.reason);
    };
    if (signal?.aborted === true) this.#forward();
    signal?.addEventListener("abort", this.#forward, { once: true });
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Aborts the wait at the deadline, on the `Clock` — however its sleep ends, never unarmed. */
  armDeadline(): void {
    const { deadlineAt, clock } = this.wait;
    if (deadlineAt === undefined) return;
    const left = Math.max(0, deadlineAt.getTime() - clock.now().getTime()) as Milliseconds;
    const fire = (): void => {
      this.#controller.abort(new DeadlineReached());
    };
    // the sleep ends early when the wait's signal aborts: aborting again changes nothing then
    clock.sleep(left, this.signal).then(fire, fire);
  }

  /** Ends the wait's own sleep when the wait is over (settled, failed or aborted). */
  close(): void {
    this.wait.signal?.removeEventListener("abort", this.#forward);
    this.#controller.abort(new Error("the wait ended"));
  }

  /** The error to end with now that the wait's signal aborted: the deadline's, or the caller's. */
  async aborted(): Promise<never> {
    const reason: unknown = this.signal.reason;
    if (reason instanceof DeadlineReached) throw await this.#deadlineError();
    throw reason;
  }

  /** The best-effort cancel, bounded by `CANCEL_TIMEOUT`, and how it went. */
  async #canceled(): Promise<Canceled> {
    const { client, clock, taskId } = this.wait;
    const bound = new AbortController();
    const asked = client
      .cancelTask({ tenant: "", id: taskId, metadata: undefined }, { signal: bound.signal })
      .then(
        (task): Canceled => ({
          // only this task's CANCELED answer is its cancel
          outcome:
            task.id === taskId && stateOf(task) === TaskState.TASK_STATE_CANCELED
              ? A2ACancelOutcome.Canceled
              : A2ACancelOutcome.NotCanceled,
          task,
        }),
        (): Canceled => ({ outcome: A2ACancelOutcome.Refused }),
      );
    const timedOut = clock
      .sleep(CANCEL_TIMEOUT, bound.signal)
      .then((): Canceled => ({ outcome: A2ACancelOutcome.NoAnswer }));
    const result = await Promise.race([asked, timedOut]);
    bound.abort(new Error("the cancel is over"));
    return result;
  }

  async #deadlineError(): Promise<A2ACallDeadlineError> {
    const { agent, clock, taskId, deadlineAt } = this.wait;
    const { outcome, task } = await this.#canceled();
    return new A2ACallDeadlineError({
      agent,
      taskId,
      contextId: safeTaskIdOf(this.#task?.contextId ?? task?.contextId) ?? "",
      deadlineAt: (deadlineAt ?? clock.now()).toISOString(),
      cancel: outcome,
    });
  }

  /** Takes one stream event (checked to be of this task): settled → the wait's result. */
  take(event: StreamResponse): Task | undefined {
    this.#task = updatedTask(this.wait, this.#task, event);
    this.wait.onEvent?.(event);
    return this.#task !== undefined && isSettled(this.#task) ? this.#task : undefined;
  }

  /** Takes one polled task (checked): reported when its state or artifacts changed. */
  took(polled: Task): Task | undefined {
    const task = checkedTask(this.wait, polled);
    const before = this.#task;
    this.#task = task;
    const isChanged =
      before === undefined ||
      stateOf(before) !== stateOf(task) ||
      before.artifacts.length !== task.artifacts.length;
    if (isChanged) this.wait.onEvent?.({ payload: { $case: "task", value: task } });
    return isSettled(task) ? task : undefined;
  }

  /** A promise that rejects with the wait's abort reason once its signal aborts. */
  abortedPromise(): Promise<never> {
    const { signal } = this;
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = (): void => {
        reject(signal.reason as Error);
      };
      if (signal.aborted) fail();
      signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => undefined); // read by the races; never unhandled
    return aborted;
  }
}
