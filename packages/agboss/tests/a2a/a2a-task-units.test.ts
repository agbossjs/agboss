/**
 * #807 — the A2A task status mapping, projection and read repair on their own: an in-memory task
 * store and an execution control of the test's, every branch of each.
 */
import { describe, expect, it } from "vitest";
import {
  DurableExecutionStatus,
  ExecutionCancelOutcome,
  type DurableExecutionState,
  type ExecutionControl,
} from "../../src/app/execution-control.js";
import { A2ATaskProjection } from "../../src/a2a/tasks/a2a-task-projection.js";
import { A2A_START_LOST, repairedTask } from "../../src/a2a/tasks/a2a-task-repair.js";
import {
  durableStatusOf,
  failedStatusOf,
  pausedStatusOf,
  UNCODED_FAILURE,
} from "../../src/a2a/tasks/task-status.js";
import { AGBossError, ExecutionCancelledError } from "../../src/core/errors.js";
import {
  A2ATaskSaveStatus,
  A2ATaskState,
  type A2ATaskKey,
  type A2ATaskRecord,
  type A2ATaskStatus,
} from "../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { PauseKind, type PendingPause } from "../../src/pause/types.js";
import { IncompatibleResumeError } from "../../src/run/resume-guard.js";
import { seconds } from "../../src/units/index.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");
const KEY = { tenantId: "default", taskId: "task-1" };

const pause = (overrides: Partial<PendingPause> = {}): PendingPause =>
  ({
    pauseId: "p-1",
    answeredBy: PauseAnswerer.ThreadOwner,
    agent: "clerk-agent",
    channel: "terminal-user-channel",
    childExecutionId: undefined,
    itemIndex: undefined,
    kind: PauseKind.Approval,
    ask: { tool: "charge-tool", args: { text: "10 USD" } },
    ...overrides,
  }) as PendingPause;

/** A clock the test moves by hand. */
const clockAt = (start: Date) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
};

/** An execution control whose answers the test scripts, recording what it was asked. */
function scripted(
  states: readonly DurableExecutionState[],
  answers: Partial<{
    claim: boolean;
    cancel: ExecutionCancelOutcome;
  }> = {},
) {
  const asked: string[] = [];
  const queue = [...states];
  const control: ExecutionControl = {
    executionStateOf: (tree) => {
      asked.push(`state ${tree.rootExecutionId} ${tree.threadId}`);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return Promise.resolve(next ?? { status: DurableExecutionStatus.NotStarted });
    },
    cancelExecution: (request) => {
      asked.push(`cancel ${request.rootExecutionId} ${String(request.ownerId)}`);
      return Promise.resolve(answers.cancel ?? ExecutionCancelOutcome.AwaitingStart);
    },
    claimExecutionId: (identity) => {
      asked.push(`claim ${identity.executionId} ${identity.tenantId}`);
      return Promise.resolve(answers.claim ?? true);
    },
  };
  return { control, asked };
}

/** A store with one task, accepted at nine in `status`. */
async function storeWith(
  status: A2ATaskStatus = { state: A2ATaskState.Submitted, pendingPauses: [] },
) {
  const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
  const save = await tasks.saveIfAbsent({
    ...KEY,
    ownerId: "alice",
    contextId: "ctx-1",
    skill: "order-workflow-start",
    status,
    acceptedAt: NINE,
    messageId: "m-1",
    requestHash: "h-1",
  });
  if (save.status !== A2ATaskSaveStatus.Saved) throw new Error(save.status);
  return { tasks, task: save.task };
}

const WORKING: A2ATaskStatus = { state: A2ATaskState.Working, pendingPauses: [] };

describe("#807: an execution's state as its task's status", () => {
  it("pauses a caller may answer → INPUT_REQUIRED with each pause's id, kind and ask only", () => {
    expect(pausedStatusOf([pause(), pause({ pauseId: "p-2", kind: PauseKind.Question })])).toEqual({
      state: A2ATaskState.InputRequired,
      pendingPauses: [
        { pauseId: "p-1", kind: PauseKind.Approval, ask: pause().ask },
        { pauseId: "p-2", kind: PauseKind.Question, ask: pause().ask },
      ],
    });
  });

  it("pauses only channels answer → WORKING, naming each channel once (G13)", () => {
    const channelOnly = (channel: string) =>
      pause({ pauseId: undefined, answeredBy: PauseAnswerer.Channel, channel });

    expect(pausedStatusOf([channelOnly("a"), channelOnly("b"), channelOnly("a")])).toEqual({
      state: A2ATaskState.Working,
      pendingPauses: [],
      message: "awaiting a, b out of band",
    });
  });

  it("both → INPUT_REQUIRED with the answerable ones, the others named", () => {
    const status = pausedStatusOf([pause(), pause({ pauseId: undefined, channel: "slack" })]);

    expect(status).toEqual({
      state: A2ATaskState.InputRequired,
      pendingPauses: [{ pauseId: "p-1", kind: PauseKind.Approval, ask: pause().ask }],
      message: "awaiting slack out of band",
    });
  });

  it("a cancel → CANCELED; a coded error → its code; any other → execution.failed", () => {
    class LimitError extends AGBossError {
      static override readonly code: string = "limit.hops";
    }

    expect(failedStatusOf(new ExecutionCancelledError("stop"))).toEqual({
      state: A2ATaskState.Canceled,
      pendingPauses: [],
    });
    expect(failedStatusOf(new LimitError("too many"))).toEqual({
      state: A2ATaskState.Failed,
      pendingPauses: [],
      errorCode: "limit.hops",
      message: "too many",
    });
    expect(failedStatusOf(new Error("boom"))).toMatchObject({ errorCode: UNCODED_FAILURE });
    expect(UNCODED_FAILURE).toBe("execution.failed");
  });

  it.each<[DurableExecutionState, A2ATaskStatus | undefined]>([
    [{ status: DurableExecutionStatus.NotStarted }, undefined],
    [{ status: DurableExecutionStatus.Running }, WORKING],
    [{ status: DurableExecutionStatus.Paused, pending: [pause()] }, pausedStatusOf([pause()])],
    [
      { status: DurableExecutionStatus.Finished, finish: "f", output: { a: 1 } },
      { state: A2ATaskState.Completed, pendingPauses: [], finish: "f", output: { a: 1 } },
    ],
    [
      { status: DurableExecutionStatus.Cancelled },
      { state: A2ATaskState.Canceled, pendingPauses: [] },
    ],
    [
      { status: DurableExecutionStatus.Failed, reason: "it broke" },
      {
        state: A2ATaskState.Failed,
        pendingPauses: [],
        errorCode: UNCODED_FAILURE,
        message: "it broke",
      },
    ],
  ])("durable %j → %j", (state, status) => {
    expect(durableStatusOf(state)).toEqual(status);
  });
});

/** An execution event of the root `task-1` (or of a child). */
const eventOf = (overrides: Record<string, unknown> = {}) =>
  ({
    executionId: "task-1",
    rootExecutionId: "task-1",
    parentExecutionId: undefined,
    threadId: "ctx-1",
    tenantId: "default",
    ...overrides,
  }) as never;

describe("#807: the projection on its own", () => {
  it("a child's event and an execution that is no task write nothing", async () => {
    const { tasks } = await storeWith();
    const projection = new A2ATaskProjection(tasks, clockAt(NINE), () => undefined);

    await projection.onExecutionStart(eventOf({ executionId: "child-1" }));
    await projection.onExecutionStart(eventOf({ executionId: "other", rootExecutionId: "other" }));

    expect(await tasks.findById(KEY)).toMatchObject({ version: 1 });
  });

  it("start and resume → WORKING at the clock's time; a pause → its status", async () => {
    const { tasks } = await storeWith();
    const clock = clockAt(NINE);
    const projection = new A2ATaskProjection(tasks, clock, () => undefined);

    clock.advance(1000);
    await projection.onExecutionStart(eventOf());
    const working = await tasks.findById(KEY);
    await projection.onExecutionPause({ ...(eventOf() as object), pending: [pause()] } as never);
    const paused = await tasks.findById(KEY);
    await projection.onExecutionResume(eventOf());

    expect(working).toMatchObject({
      status: WORKING,
      version: 2,
      statusAt: new Date(NINE.getTime() + 1000),
    });
    expect(paused?.status).toEqual(pausedStatusOf([pause()]));
    expect(await tasks.findById(KEY)).toMatchObject({ status: WORKING, version: 4 });
  });

  it("an end → COMPLETED from the records; nothing while they show no finish or no app", async () => {
    const finished = { status: DurableExecutionStatus.Finished, finish: "f", output: 1 } as const;
    const end = { ...(eventOf() as object), finish: { name: "f" } } as never;
    const { tasks } = await storeWith(WORKING);

    await new A2ATaskProjection(tasks, clockAt(NINE), () => undefined).onExecutionEnd(end);
    const unbound = await tasks.findById(KEY);
    const running = scripted([{ status: DurableExecutionStatus.Running }]);
    await new A2ATaskProjection(tasks, clockAt(NINE), () => running.control).onExecutionEnd(end);
    const notYet = await tasks.findById(KEY);
    const done = scripted([finished]);
    await new A2ATaskProjection(tasks, clockAt(NINE), () => done.control).onExecutionEnd(end);

    expect(unbound?.version).toBe(1);
    expect(notYet?.version).toBe(1);
    expect(done.asked).toEqual(["state task-1 ctx-1"]);
    expect((await tasks.findById(KEY))?.status).toEqual({
      state: A2ATaskState.Completed,
      pendingPauses: [],
      finish: "f",
      output: 1,
    });
  });

  it("an error → FAILED; an incompatible resume changes nothing; a terminal task is left", async () => {
    const { tasks } = await storeWith(WORKING);
    const projection = new A2ATaskProjection(tasks, clockAt(NINE), () => undefined);
    const errorOf = (error: Error) => ({ ...(eventOf() as object), error }) as never;

    await projection.onExecutionError(
      errorOf(Object.create(IncompatibleResumeError.prototype) as IncompatibleResumeError),
    );
    const kept = await tasks.findById(KEY);
    await projection.onExecutionError(errorOf(new Error("boom")));
    const failed = await tasks.findById(KEY);
    await projection.onExecutionStart(eventOf());

    expect(kept?.version).toBe(1);
    expect(failed?.status).toEqual(failedStatusOf(new Error("boom")));
    expect(await tasks.findById(KEY)).toEqual(failed);
  });

  it("a write another writer won is read and tried again, three times at most", async () => {
    const { tasks } = await storeWith();
    let lost = 0;
    let reads = 0;
    const racing = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      findById: (key: A2ATaskKey) => {
        reads += 1;
        return tasks.findById(key);
      },
      compareAndSetStatus: (
        ...args: Parameters<InMemoryA2ATaskRepository["compareAndSetStatus"]>
      ) => {
        lost += 1;
        return lost <= 2 ? Promise.resolve(undefined) : tasks.compareAndSetStatus(...args);
      },
    });
    const always = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      findById: (key: A2ATaskKey) => {
        reads += 1;
        return tasks.findById(key);
      },
      compareAndSetStatus: () => Promise.resolve(undefined),
    });

    await new A2ATaskProjection(racing, clockAt(NINE), () => undefined).onExecutionStart(eventOf());
    const third = reads;
    reads = 0;
    await new A2ATaskProjection(always, clockAt(NINE), () => undefined).onExecutionResume(
      eventOf(),
    );

    expect(third).toBe(3);
    expect(reads).toBe(3);
    expect(await tasks.findById(KEY)).toMatchObject({ status: WORKING, version: 2 });
  });
});

describe("#807: read repair on its own", () => {
  const partsOf = (tasks: InMemoryA2ATaskRepository, control: ExecutionControl, now: Date) => ({
    tasks,
    control,
    clock: { now: () => now },
    staleAfter: seconds(30),
    startTimeout: seconds(60),
  });
  const after = (ms: number) => new Date(NINE.getTime() + ms);

  it("a terminal task, and one changed less than a lease period ago, are not read again", async () => {
    const done: A2ATaskStatus = { state: A2ATaskState.Completed, pendingPauses: [] };
    const { tasks, task } = await storeWith(done);
    const fresh = await storeWith(WORKING);
    const { control, asked } = scripted([{ status: DurableExecutionStatus.Running }]);

    expect(await repairedTask(partsOf(tasks, control, after(600_000)), task)).toBe(task);
    expect(await repairedTask(partsOf(fresh.tasks, control, after(29_999)), fresh.task)).toBe(
      fresh.task,
    );
    expect(asked).toEqual([]);
  });

  it("a stale task the records put elsewhere is written; one they agree with is not", async () => {
    const { tasks, task } = await storeWith(pausedStatusOf([pause()]));
    const running = scripted([{ status: DurableExecutionStatus.Running }]);
    const same = await storeWith(WORKING);

    const repaired = await repairedTask(partsOf(tasks, running.control, after(30_000)), task);
    const agreed = await repairedTask(
      partsOf(same.tasks, running.control, after(30_000)),
      same.task,
    );

    expect(repaired).toMatchObject({ status: WORKING, version: 2, statusAt: after(30_000) });
    expect(agreed).toBe(same.task);
  });

  it("a write another writer won: the task as read again", async () => {
    const { tasks, task } = await storeWith(WORKING);
    await tasks.compareAndSetStatus(KEY, 1, pausedStatusOf([pause()]), after(1));
    const { control } = scripted([{ status: DurableExecutionStatus.Cancelled }]);

    const repaired = await repairedTask(partsOf(tasks, control, after(30_000)), task);

    expect(repaired).toEqual(await tasks.findById(KEY));
    expect(repaired.version).toBe(2);
  });

  it("not started: a task already working, or submitted within its start timeout, waits", async () => {
    const working = await storeWith(WORKING);
    const submitted = await storeWith();
    const { control, asked } = scripted([{ status: DurableExecutionStatus.NotStarted }]);

    expect(await repairedTask(partsOf(working.tasks, control, after(600_000)), working.task)).toBe(
      working.task,
    );
    expect(
      await repairedTask(partsOf(submitted.tasks, control, after(59_999)), submitted.task),
    ).toBe(submitted.task);
    expect(asked.filter((call) => !call.startsWith("state"))).toEqual([]);
  });

  it("a start lost: the sweep's fence wins → FAILED a2a.start-lost, nothing cancelled", async () => {
    const { tasks, task } = await storeWith();
    const { control, asked } = scripted([{ status: DurableExecutionStatus.NotStarted }]);

    const repaired = await repairedTask(partsOf(tasks, control, after(60_000)), task);

    expect(repaired.status).toEqual({
      state: A2ATaskState.Failed,
      pendingPauses: [],
      errorCode: A2A_START_LOST,
      message: "the task's execution never started",
    });
    expect(A2A_START_LOST).toBe("a2a.start-lost");
    expect(asked).toEqual(["state task-1 ctx-1", "claim task-1 default"]);
  });

  it("a start kept the id and left nothing: its tree gets a cancel, then FAILED a2a.start-lost", async () => {
    const { tasks, task } = await storeWith();
    const { control, asked } = scripted([{ status: DurableExecutionStatus.NotStarted }], {
      claim: false,
    });

    const repaired = await repairedTask(partsOf(tasks, control, after(60_000)), task);

    expect(repaired.status.errorCode).toBe(A2A_START_LOST);
    expect(asked).toEqual(["state task-1 ctx-1", "claim task-1 default", "cancel task-1 alice"]);
  });

  it("a start that began meanwhile: its true state, never start-lost", async () => {
    const { tasks, task } = await storeWith();
    const { control, asked } = scripted(
      [{ status: DurableExecutionStatus.NotStarted }, { status: DurableExecutionStatus.Running }],
      { claim: false, cancel: ExecutionCancelOutcome.Requested },
    );

    const repaired = await repairedTask(partsOf(tasks, control, after(60_000)), task);

    expect(repaired.status).toEqual(WORKING);
    expect(asked.at(-1)).toBe("state task-1 ctx-1");
  });
});
