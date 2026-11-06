import type {
  OnExecutionEnd,
  OnExecutionError,
  OnExecutionPause,
  OnExecutionResume,
  OnExecutionStart,
} from "../../core/observer-hooks.js";
import type {
  ExecutionEndEvent,
  ExecutionErrorEvent,
  ExecutionPauseEvent,
} from "../../core/observability.js";
import type { ExecutionEvent } from "../../flow/observers/execution-event.js";
import { DurableExecutionStatus, type ExecutionControl } from "../../app/execution-control.js";
import type { Clock } from "../../infrastructure/clock.js";
import {
  isTerminalA2ATaskState,
  type A2ATaskRepository,
  type A2ATaskStatus,
} from "../../infrastructure/a2a-task.repository.js";
import { IncompatibleResumeError } from "../../run/resume-guard.js";
import { completedStatusOf, failedStatusOf, pausedStatusOf, WORKING } from "./task-status.js";

/** How many times a write lost to another writer is read and tried again. */
const ATTEMPTS = 3;

/**
 * The A2A task projection (#807, design §4.1.3 step 7): a framework observer, registered when the
 * application exposes an `@A2AExpose`, that moves a root execution's task — the task whose id is
 * the execution's reserved id — with its events: start and resume → `WORKING`, a rest at pauses →
 * `INPUT_REQUIRED` (or `WORKING` with a message for channel-only pauses), an end → `COMPLETED`
 * with the finish's output read from the durable records, an error → `FAILED` / `CANCELED`. It
 * runs wherever the tree's pass runs (recovery included). Every write is a compare-and-set on the
 * task's version and a terminal status is never left; executions that are no task are skipped.
 * Events are at most once (#562, #597): a status they miss is repaired on read.
 */
export class A2ATaskProjection
  implements OnExecutionStart, OnExecutionPause, OnExecutionResume, OnExecutionEnd, OnExecutionError
{
  constructor(
    private readonly tasks: A2ATaskRepository,
    private readonly clock: Pick<Clock, "now">,
    /** The instance's trees by id, bound once its app is built. */
    private readonly control: () => ExecutionControl | undefined,
  ) {}

  onExecutionStart(event: ExecutionEvent): Promise<void> {
    return this.#move(event, () => Promise.resolve(WORKING));
  }

  onExecutionPause(event: ExecutionPauseEvent): Promise<void> {
    return this.#move(event, () => Promise.resolve(pausedStatusOf(event.pending)));
  }

  onExecutionResume(event: ExecutionEvent): Promise<void> {
    return this.#move(event, () => Promise.resolve(WORKING));
  }

  /** The output is no event's: read from the records, once the finish is durable. */
  onExecutionEnd(event: ExecutionEndEvent): Promise<void> {
    return this.#move(event, async () => {
      const control = this.control();
      if (control === undefined) return undefined;
      const tree = { ...event, rootExecutionId: event.executionId };
      const state = await control.executionStateOf(tree);
      return state.status === DurableExecutionStatus.Finished
        ? completedStatusOf(state.finish, state.output)
        : undefined;
    });
  }

  /** An incompatible resume leaves the execution paused: no change. */
  onExecutionError(event: ExecutionErrorEvent): Promise<void> {
    if (event.error instanceof IncompatibleResumeError) return Promise.resolve();
    return this.#move(event, () => Promise.resolve(failedStatusOf(event.error)));
  }

  /** Writes the status of a root execution's task, if it is one, unless it is over. */
  async #move(
    event: ExecutionEvent,
    statusOf: () => Promise<A2ATaskStatus | undefined>,
  ): Promise<void> {
    if (event.executionId !== event.rootExecutionId) return;
    const key = { tenantId: event.tenantId, taskId: event.executionId };
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const task = await this.tasks.findById(key);
      if (task === undefined || isTerminalA2ATaskState(task.status.state)) return;
      const status = await statusOf();
      if (status === undefined) return;
      const written = await this.tasks.compareAndSetStatus(
        key,
        task.version,
        status,
        this.clock.now(),
      );
      if (written !== undefined) return;
    }
  }
}
