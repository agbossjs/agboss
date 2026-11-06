/**
 * #824 (mutation shard `a2a-server`): the server's wait and cancel on their own — when a send
 * stops waiting, a wait's read once its run here ended (forced from the records) or not (as kept),
 * a task swept while waited for; a cancel of a task not started (fenced, `CANCELED`), of one that
 * runs (its tree's cancel, read from the records at once), of one another end took first
 * (`-32002`), of one swept meanwhile.
 */
import { describe, expect, it } from "vitest";
import { canceledTask } from "../../../src/a2a/server/a2a-cancel-task.js";
import { changedTask, isAtRest, restingTask } from "../../../src/a2a/server/a2a-task-wait.js";
import { taskChanged } from "../../../src/a2a/tasks/task-changes.js";
import {
  DurableExecutionStatus,
  ExecutionCancelOutcome,
} from "../../../src/app/execution-control.js";
import {
  A2ATaskState,
  type A2ATaskRecord,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import {
  callerOf,
  refusalOf,
  savedTask,
  scriptOf,
  unitParts,
  WORKING,
} from "./support/unit-parts.js";

const INPUT_REQUIRED = { state: A2ATaskState.InputRequired, pendingPauses: [] };
const FINISHED = {
  status: DurableExecutionStatus.Finished,
  finish: "unit-workflow-finish",
  output: { text: "done" },
} as const;

const newTasks = () => new InMemoryA2ATaskRepository(new InMemoryDatabase());

/** A store whose task is gone once read for a wait: swept meanwhile. */
const sweptStore = (tasks: InMemoryA2ATaskRepository) =>
  Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
    findById: () => Promise.resolve(undefined),
  });

describe("#824: when a send stops waiting", () => {
  it("over, or waiting for its caller past the version a follow-up's answer found", async () => {
    const tasks = newTasks();
    const waiting: A2ATaskRecord = await savedTask(tasks, {}, INPUT_REQUIRED);

    expect(waiting.version).toBe(2);
    expect(isAtRest(waiting)).toBe(true);
    expect(isAtRest(waiting, 1)).toBe(true);
    expect(isAtRest(waiting, 2)).toBe(false);
    expect(isAtRest({ ...waiting, status: WORKING })).toBe(false);
    expect(isAtRest({ ...waiting, status: { ...WORKING, state: A2ATaskState.Failed } }, 9)).toBe(
      true,
    );
  });
});

describe("#824: a wait's read after the task's next change", () => {
  it("its run here ended: read against its records at once", async () => {
    const tasks = newTasks();
    const task = await savedTask(tasks, {}, WORKING);
    const script = scriptOf({ state: FINISHED });
    const parts = unitParts(script, tasks);
    void parts.runs.start(task, () => Promise.resolve());

    const read = await changedTask(parts, task, new AbortController().signal);

    expect(read.status).toMatchObject({
      state: A2ATaskState.Completed,
      finish: "unit-workflow-finish",
    });
  });

  it("woken by a change, no run here: the task as kept, its records not read", async () => {
    const tasks = newTasks();
    const task = await savedTask(tasks, {}, WORKING);
    const script = scriptOf({ state: FINISHED });
    const parts = unitParts(script, tasks);

    const waited = changedTask(parts, task, new AbortController().signal);
    await Promise.resolve();
    taskChanged(task);
    const read = await waited;

    expect(read.status).toEqual(WORKING);
    expect(script.calls).toEqual([]);
  });

  it("swept while waited for: not found", async () => {
    const tasks = newTasks();
    const task = await savedTask(tasks, {}, WORKING);
    const parts = unitParts(scriptOf(), sweptStore(tasks));
    const aborted = AbortSignal.abort();

    expect(await refusalOf(changedTask(parts, task, aborted))).toBe(
      "TaskNotFoundError: task not found",
    );
  });

  it("a resting task is not waited for; an aborted wait gives the task as it is", async () => {
    const tasks = newTasks();
    const task = await savedTask(tasks, {}, WORKING);
    const parts = unitParts(scriptOf(), tasks);

    expect(await restingTask(parts, task, AbortSignal.abort())).toBe(task);
  });
});

describe("#824: CancelTask", () => {
  it("a task not started is fenced and CANCELED at once, its tree never asked", async () => {
    const tasks = newTasks();
    await savedTask(tasks);
    const script = scriptOf();

    const canceled = await canceledTask(unitParts(script, tasks), callerOf(), "task-1");

    expect(canceled.status).toEqual({ state: A2ATaskState.Canceled, pendingPauses: [] });
    expect(script.calls).toEqual(["claim task-1"]);
  });

  it("a task not started whose id a start kept first: its tree's cancel, read at once", async () => {
    const tasks = newTasks();
    await savedTask(tasks);
    const script = scriptOf({ claims: false, state: { status: DurableExecutionStatus.Cancelled } });

    const canceled = await canceledTask(unitParts(script, tasks), callerOf(), "task-1");

    expect(canceled.status.state).toBe(A2ATaskState.Canceled);
    expect(script.calls).toEqual(["claim task-1", "cancel task-1 dana", "state task-1"]);
  });

  it("a running task: never fenced, its tree's cancel asked, its records read now", async () => {
    const tasks = newTasks();
    await savedTask(tasks, {}, WORKING);
    const script = scriptOf({ state: { status: DurableExecutionStatus.Cancelled } });

    const canceled = await canceledTask(unitParts(script, tasks), callerOf(), "task-1");

    expect(canceled.status.state).toBe(A2ATaskState.Canceled);
    expect(script.calls).toEqual(["cancel task-1 dana", "state task-1"]);
  });

  it("a running task still running elsewhere: WORKING until its holder stops", async () => {
    const tasks = newTasks();
    await savedTask(tasks, {}, WORKING);
    const script = scriptOf({ cancel: ExecutionCancelOutcome.Requested });

    const canceled = await canceledTask(unitParts(script, tasks), callerOf(), "task-1");

    expect(canceled.status).toEqual(WORKING);
  });

  it("aborted here: answered once its run here ended", async () => {
    const tasks = newTasks();
    const task = await savedTask(tasks, {}, WORKING);
    const script = scriptOf({
      cancel: ExecutionCancelOutcome.Aborted,
      state: { status: DurableExecutionStatus.Cancelled },
    });
    const parts = unitParts(script, tasks);
    let isEnded = false;
    void parts.runs.start(task, async () => {
      await Promise.resolve();
      isEnded = true;
    });

    const canceled = await canceledTask(parts, callerOf(), "task-1");

    expect([isEnded, canceled.status.state]).toEqual([true, A2ATaskState.Canceled]);
  });

  it("another end first (the records say finished), or over already: -32002", async () => {
    const tasks = newTasks();
    await savedTask(tasks, {}, WORKING);
    const finished = unitParts(scriptOf({ state: FINISHED }), tasks);

    expect(await refusalOf(canceledTask(finished, callerOf(), "task-1"))).toBe(
      "TaskNotCancelableError: the task is over: it cannot be canceled",
    );
    expect(await refusalOf(canceledTask(finished, callerOf(), "task-1"))).toBe(
      "TaskNotCancelableError: the task is over: it cannot be canceled",
    );
  });

  it("swept while its cancel was asked: not found", async () => {
    const tasks = newTasks();
    await savedTask(tasks, {}, WORKING);
    const once = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      reads: 0,
      findById(this: { reads: number }, key: { tenantId: string; taskId: string }) {
        this.reads += 1;
        return this.reads === 1 ? tasks.findById(key) : Promise.resolve(undefined);
      },
    });

    expect(await refusalOf(canceledTask(unitParts(scriptOf(), once), callerOf(), "task-1"))).toBe(
      "TaskNotFoundError: task not found",
    );
  });
});
