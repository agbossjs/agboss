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
import type { FrameworkLog } from "../../infrastructure/logger.js";
import {
  isTerminalA2ATaskState,
  type A2ATaskRepository,
  type A2ATaskStatus,
} from "../../infrastructure/a2a-task.repository.js";
import { IncompatibleResumeError } from "../../run/resume-guard.js";
import { completedStatusOf, failedStatusOf, pausedStatusOf, WORKING } from "./task-status.js";
import { taskChanged } from "./task-changes.js";

/** How many times a write lost to another writer is read and tried again. */
const ATTEMPTS = 3;

/** What the projection writes through, and where it says a write it gave up. */
export interface A2ATaskProjectionParts {
  readonly tasks: A2ATaskRepository;
  readonly clock: Pick<Clock, "now">;
  readonly log: Pick<FrameworkLog, "warn">;
  /** The instance's trees by id, bound once its app is built. */
  readonly control: () => ExecutionControl | undefined;
}

/**
 * The A2A task projection (#807, design §4.1.3 step 7): a framework observer, registered when the
 * application exposes an `@A2AExpose`, that moves a root execution's task — the task whose id is
 * the execution's reserved id, on the task's own context — with its events: start and resume →
 * `WORKING`, a rest at pauses → `INPUT_REQUIRED` (or `WORKING` with a message for channel-only
 * pauses), an end → `COMPLETED` with the finish's output, an error → `FAILED` with its code /
 * `CANCELED`. A terminal status is written only once the execution's durable records show that
 * end (a finish, a failed or cancelled record): an error event of a pass whose record still runs —
 * recovery will continue it — changes nothing, so no final status is ever written early. Every
 * write is a compare-and-set on the task's version and a terminal status is never left. Events are
 * at most once (#562, #597): a status they miss is repaired on read.
 */
export class A2ATaskProjection
  implements OnExecutionStart, OnExecutionPause, OnExecutionResume, OnExecutionEnd, OnExecutionError
{
  constructor(private readonly parts: A2ATaskProjectionParts) {}

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
      const state = await this.#durableStateOf(event);
      return state.status === DurableExecutionStatus.Finished
        ? completedStatusOf(state.finish, state.output)
        : undefined;
    });
  }

  /** An incompatible resume leaves the execution paused: no change. */
  onExecutionError(event: ExecutionErrorEvent): Promise<void> {
    if (event.error instanceof IncompatibleResumeError) return Promise.resolve();
    return this.#move(event, async () => {
      const { status } = await this.#durableStateOf(event);
      const isOver =
        status === DurableExecutionStatus.Failed || status === DurableExecutionStatus.Cancelled;
      return isOver ? failedStatusOf(event.error) : undefined;
    });
  }

  /** A tree's state from its records; a projection with no app to read them is a wiring bug. */
  #durableStateOf(event: ExecutionEvent) {
    const control = this.parts.control();
    if (control === undefined)
      throw new Error("the A2A task projection runs before its application's trees are bound");
    return control.executionStateOf({ ...event, rootExecutionId: event.executionId });
  }

  /** Writes the status of a root execution's task, if it is one, unless it is over. */
  async #move(
    event: ExecutionEvent,
    statusOf: () => Promise<A2ATaskStatus | undefined>,
  ): Promise<void> {
    if (event.executionId !== event.rootExecutionId) return;
    const { tasks, clock, log } = this.parts;
    const key = { tenantId: event.tenantId, taskId: event.executionId };
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const task = await tasks.findById(key);
      // another execution's id on another context is never this task's (an id minted twice)
      if (task?.contextId !== event.threadId || isTerminalA2ATaskState(task.status.state)) return;
      const status = await statusOf();
      if (status === undefined) return;
      if ((await tasks.compareAndSetStatus(key, task.version, status, clock.now())) !== undefined) {
        taskChanged(key);
        return;
      }
    }
    const text = `task ${key.taskId} changed ${String(ATTEMPTS)} times under its projection: left to its read repair`;
    log.warn("a2a.task-projection-contended", text, {
      tenantId: key.tenantId,
      executionId: key.taskId,
    });
  }
}
