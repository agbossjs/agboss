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
  failureMessageOf,
  INTERNAL_FAILURE,
  pausedStatusOf,
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
    step: "clerk-agent",
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
      message: "the task failed: limit.hops",
    });
    expect(failedStatusOf(new Error("boom"))).toMatchObject({ errorCode: INTERNAL_FAILURE });
  });

  it("an error's own text never reaches the task: an uncoded one is `internal`, the task failed", () => {
    const leaky = new Error("refund to alice@example.com failed with key sk-live-51HxQ9fake");

    const status = failedStatusOf(leaky);

    expect(status).toEqual({
      state: A2ATaskState.Failed,
      pendingPauses: [],
      errorCode: INTERNAL_FAILURE,
      message: "the task failed",
    });
    expect(INTERNAL_FAILURE).toBe("internal");
    expect(JSON.stringify(status)).not.toMatch(/alice@example\.com|sk-live/u);
  });

  it("a coded error maps to its code and the fixed text of that code, never its message", () => {
    class LeakyLimitError extends AGBossError {
      static override readonly code: string = "limit.budget";
    }

    const status = failedStatusOf(new LeakyLimitError("budget of bob@example.com exhausted"));

    expect(status).toEqual({
      state: A2ATaskState.Failed,
      pendingPauses: [],
      errorCode: "limit.budget",
      message: "the task failed: limit.budget",
    });
    expect(failureMessageOf("limit.budget")).toBe("the task failed: limit.budget");
    expect(failureMessageOf(INTERNAL_FAILURE)).toBe("the task failed");
  });

  it("a failure read back from a record keeps its reason out of the task", () => {
    const status = durableStatusOf({
      status: DurableExecutionStatus.Failed,
      reason: "tool charge-tool: card 4242 4242 4242 4242 of carol@example.com declined",
    });

    expect(status).toEqual({
      state: A2ATaskState.Failed,
      pendingPauses: [],
      errorCode: INTERNAL_FAILURE,
      message: "the task failed",
    });
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
        errorCode: INTERNAL_FAILURE,
        message: "the task failed",
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

/** A projection over `tasks`, the test's control, its log of warnings. */
function projectionOf(
  tasks: InMemoryA2ATaskRepository,
  control?: ExecutionControl,
  clock = clockAt(NINE),
) {
  const warnings: string[] = [];
  const projection = new A2ATaskProjection({
    tasks,
    clock,
    log: {
      warn: (code, message, subject) => {
        warnings.push(`${code} | ${message} | ${JSON.stringify(subject)}`);
      },
    },
    control: () => control,
  });
  return { projection, warnings };
}

const FINISHED = { status: DurableExecutionStatus.Finished, finish: "f", output: 1 } as const;

describe("#807: the projection on its own", () => {
  it("a child's event, another execution's, and one on another context write nothing", async () => {
    const { tasks } = await storeWith();
    const { projection } = projectionOf(tasks);

    await projection.onExecutionStart(eventOf({ executionId: "child-1" }));
    // a child whose own id is the task's: a child is never a task
    await projection.onExecutionStart(eventOf({ rootExecutionId: "root-x" }));
    await projection.onExecutionStart(eventOf({ executionId: "other", rootExecutionId: "other" }));
    // an id minted twice: the same id on another thread is never this task's (review #3)
    await projection.onExecutionStart(eventOf({ threadId: "ctx-other" }));

    expect(await tasks.findById(KEY)).toMatchObject({ version: 1 });
  });

  it("start and resume → WORKING at the clock's time; a pause → its status", async () => {
    const { tasks } = await storeWith();
    const clock = clockAt(NINE);
    const { projection } = projectionOf(tasks, undefined, clock);

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

  it("an end → COMPLETED from the records, with what it spent (#810); nothing while they show no finish", async () => {
    const spend = { totalUsd: 0.25 };
    const end = { ...(eventOf() as object), finish: { name: "f" }, spend } as never;
    const { tasks } = await storeWith(WORKING);

    const running = scripted([{ status: DurableExecutionStatus.Running }]);
    await projectionOf(tasks, running.control).projection.onExecutionEnd(end);
    const notYet = await tasks.findById(KEY);
    const done = scripted([FINISHED]);
    await projectionOf(tasks, done.control).projection.onExecutionEnd(end);

    expect(notYet?.version).toBe(1);
    expect(done.asked).toEqual(["state task-1 ctx-1"]);
    expect((await tasks.findById(KEY))?.status).toEqual({
      state: A2ATaskState.Completed,
      pendingPauses: [],
      finish: "f",
      output: 1,
      spentUsd: 0.25,
    });
  });

  it("a projection with no application to read the records from rejects: a wiring bug", async () => {
    const { tasks } = await storeWith(WORKING);
    const end = { ...(eventOf() as object), finish: { name: "f" } } as never;

    await expect(projectionOf(tasks).projection.onExecutionEnd(end)).rejects.toThrow(
      /before its application's trees are bound/u,
    );
    expect(await tasks.findById(KEY)).toMatchObject({ version: 1 });
  });

  it("an error → FAILED only once the records show the end (H2); a cancel → CANCELED", async () => {
    const errorOf = (error: Error) => ({ ...(eventOf() as object), error }) as never;
    const running = await storeWith(WORKING);
    const failed = await storeWith(WORKING);
    const cancelled = await storeWith(WORKING);

    // the pass failed but its record still runs: recovery continues it — no final status
    const stillRunning = scripted([{ status: DurableExecutionStatus.Running }]);
    await projectionOf(running.tasks, stillRunning.control).projection.onExecutionError(
      errorOf(new Error("the store blinked")),
    );
    const over = scripted([{ status: DurableExecutionStatus.Failed, reason: "x" }]);
    await projectionOf(failed.tasks, over.control).projection.onExecutionError(
      errorOf(new Error("alice@example.com")),
    );
    const stopped = scripted([{ status: DurableExecutionStatus.Cancelled }]);
    await projectionOf(cancelled.tasks, stopped.control).projection.onExecutionError(
      errorOf(new ExecutionCancelledError("stop")),
    );

    expect((await running.tasks.findById(KEY))?.version).toBe(1);
    expect((await failed.tasks.findById(KEY))?.status).toEqual(failedStatusOf(new Error("x")));
    expect((await cancelled.tasks.findById(KEY))?.status.state).toBe(A2ATaskState.Canceled);
  });

  it("an incompatible resume changes nothing and reads nothing; a terminal task is left", async () => {
    const { tasks } = await storeWith(WORKING);
    const errorOf = (error: Error) => ({ ...(eventOf() as object), error }) as never;
    const over = scripted([{ status: DurableExecutionStatus.Failed, reason: "x" }]);
    const { projection } = projectionOf(tasks, over.control);

    await projection.onExecutionError(
      errorOf(Object.create(IncompatibleResumeError.prototype) as IncompatibleResumeError),
    );
    const kept = await tasks.findById(KEY);
    const asked = [...over.asked];
    await projection.onExecutionError(errorOf(new Error("boom")));
    const failed = await tasks.findById(KEY);
    await projection.onExecutionStart(eventOf());

    expect(kept?.version).toBe(1);
    expect(asked).toEqual([]);
    expect(failed?.status.state).toBe(A2ATaskState.Failed);
    expect(await tasks.findById(KEY)).toEqual(failed);
  });

  it("a write another writer won is read and tried again; three lost, it is logged", async () => {
    const { tasks } = await storeWith();
    let lost = 0;
    let reads = 0;
    const counting = (store: object) =>
      Object.assign(store, {
        findById: (key: A2ATaskKey) => {
          reads += 1;
          return tasks.findById(key);
        },
      });
    const racing = counting(
      Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
        compareAndSetStatus: (
          ...args: Parameters<InMemoryA2ATaskRepository["compareAndSetStatus"]>
        ) => {
          lost += 1;
          return lost <= 2 ? Promise.resolve(undefined) : tasks.compareAndSetStatus(...args);
        },
      }),
    ) as InMemoryA2ATaskRepository;
    const always = counting(
      Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
        compareAndSetStatus: () => Promise.resolve(undefined),
      }),
    ) as InMemoryA2ATaskRepository;

    const won = projectionOf(racing);
    await won.projection.onExecutionStart(eventOf());
    const third = reads;
    reads = 0;
    const gaveUp = projectionOf(always);
    await gaveUp.projection.onExecutionResume(eventOf());

    expect(third).toBe(3);
    expect(won.warnings).toEqual([]);
    expect(reads).toBe(3);
    expect(gaveUp.warnings).toEqual([
      "a2a.task-projection-contended | task task-1 changed 3 times under its projection: left to its read repair | " +
        JSON.stringify({ tenantId: "default", executionId: "task-1" }),
    ]);
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
  const NOT_STARTED = { status: DurableExecutionStatus.NotStarted } as const;

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

  it("a status equal once stored is no change (L1): an undefined field, a date in the output", async () => {
    const withUndefined = { ...WORKING, message: undefined } as A2ATaskStatus;
    const { tasks, task } = await storeWith(withUndefined);
    const { control } = scripted([{ status: DurableExecutionStatus.Running }]);

    expect(await repairedTask(partsOf(tasks, control, after(30_000)), task)).toBe(task);
  });

  it("a write another writer won: the task as read again", async () => {
    const { tasks, task } = await storeWith(WORKING);
    await tasks.compareAndSetStatus(KEY, 1, pausedStatusOf([pause()]), after(1));
    const { control } = scripted([{ status: DurableExecutionStatus.Cancelled }]);

    const repaired = await repairedTask(partsOf(tasks, control, after(30_000)), task);

    expect(repaired).toEqual(await tasks.findById(KEY));
    expect(repaired.version).toBe(2);
  });

  it("not begun within its start timeout: the task waits, whatever its state", async () => {
    const working = await storeWith(WORKING);
    const submitted = await storeWith();
    const { control, asked } = scripted([NOT_STARTED]);

    expect(await repairedTask(partsOf(working.tasks, control, after(59_999)), working.task)).toBe(
      working.task,
    );
    expect(
      await repairedTask(partsOf(submitted.tasks, control, after(59_999)), submitted.task),
    ).toBe(submitted.task);
    expect(asked.filter((call) => !call.startsWith("state"))).toEqual([]);
  });

  it("a start lost: the fence wins → FAILED a2a.start-lost, nothing cancelled — WORKING too (review #2)", async () => {
    const submitted = await storeWith();
    const working = await storeWith(WORKING);
    const first = scripted([NOT_STARTED]);
    const second = scripted([NOT_STARTED]);

    const lost = await repairedTask(
      partsOf(submitted.tasks, first.control, after(60_000)),
      submitted.task,
    );
    const lostWorking = await repairedTask(
      partsOf(working.tasks, second.control, after(60_000)),
      working.task,
    );

    expect(lost.status).toEqual({
      state: A2ATaskState.Failed,
      pendingPauses: [],
      errorCode: A2A_START_LOST,
      message: "the task's execution never started",
    });
    expect(lostWorking.status.errorCode).toBe(A2A_START_LOST);
    expect(A2A_START_LOST).toBe("a2a.start-lost");
    expect(first.asked).toEqual(["state task-1 ctx-1", "claim task-1 default"]);
  });

  it("an invalid acceptance time never settles a task as lost", async () => {
    const { tasks, task } = await storeWith();
    const { control, asked } = scripted([NOT_STARTED]);

    const broken = { ...task, acceptedAt: new Date(Number.NaN) };

    expect(await repairedTask(partsOf(tasks, control, after(600_000)), broken)).toBe(broken);
    expect(asked).toEqual(["state task-1 ctx-1"]);
  });

  it("a start kept the id and left nothing: a cancel request, then start-lost one start timeout later (H1)", async () => {
    const { tasks, task } = await storeWith();
    const { control, asked } = scripted([NOT_STARTED], { claim: false });

    const requested = await repairedTask(partsOf(tasks, control, after(60_000)), task);
    const early = await repairedTask(partsOf(tasks, control, after(119_999)), requested);
    const settled = await repairedTask(partsOf(tasks, control, after(120_000)), requested);

    expect(requested.status).toEqual({
      state: A2ATaskState.Submitted,
      pendingPauses: [],
      cancelRequestedAt: after(60_000).toISOString(),
    });
    expect(early).toBe(requested);
    expect(settled.status.errorCode).toBe(A2A_START_LOST);
    expect(asked.filter((call) => call.startsWith("cancel"))).toEqual(["cancel task-1 alice"]);
  });

  it("a start that began meanwhile: its true state, never start-lost", async () => {
    const { tasks, task } = await storeWith();
    const { control, asked } = scripted([NOT_STARTED, { status: DurableExecutionStatus.Running }], {
      claim: false,
      cancel: ExecutionCancelOutcome.Requested,
    });

    const repaired = await repairedTask(partsOf(tasks, control, after(60_000)), task);

    expect(repaired.status).toEqual(WORKING);
    expect(asked.at(-1)).toBe("state task-1 ctx-1");
  });
});

describe("#810: the mesh's statuses", () => {
  const entry = { application: "billing-application", start: "charge-workflow-start" };
  const chain = [{ application: "orders-application", start: "o", executionId: "e-1" }];

  it("a refused chain: REJECTED with the limit's code, its fixed text and its facts", async () => {
    const { HopsLimitExceededError, MeshLoopDetectedError } =
      await import("../../src/mesh/mesh-errors.js");
    const { rejectedStatusOf } = await import("../../src/a2a/tasks/task-status.js");

    expect(rejectedStatusOf(new HopsLimitExceededError(entry, chain, 1))).toStrictEqual({
      state: A2ATaskState.Rejected,
      pendingPauses: [],
      errorCode: "limit.hops",
      message: "the task was rejected: limit.hops",
      errorDetails: { entry, chain, maxMeshHops: 1 },
    });
    expect(rejectedStatusOf(new MeshLoopDetectedError(entry, chain))).toMatchObject({
      errorCode: "limit.mesh-loop",
      errorDetails: { entry, chain },
    });
  });

  it("a completion keeps what it spent only when its end said; none is no key at all", async () => {
    const { completedStatusOf } = await import("../../src/a2a/tasks/task-status.js");

    expect(completedStatusOf("f", 1, 0.5)).toStrictEqual({
      state: A2ATaskState.Completed,
      pendingPauses: [],
      finish: "f",
      output: 1,
      spentUsd: 0.5,
    });
    expect(completedStatusOf("f", 1)).not.toHaveProperty("spentUsd");
  });
});
