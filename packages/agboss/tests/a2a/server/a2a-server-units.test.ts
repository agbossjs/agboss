/**
 * #808 (mutation shard `a2a-tasks`): the server's small parts on their own — the in-process
 * wake-ups of a task's waiters, the request admitted as the SDK decodes it, the caller as the
 * handler reads it, the owned task, the end of a task no execution can start under, and the
 * read repair's wake-up.
 */
import { ServerCallContext } from "@a2a-js/sdk/server";
import { describe, expect, it } from "vitest";
import { A2AOperation } from "../../../src/a2a/a2a-caller.js";
import { admittedRequestOf } from "../../../src/a2a/server/a2a-admitted.js";
import {
  callerOf,
  callerState,
  endedUnstarted,
  logSubjectOf,
  ownedTask,
  repairedOf,
  type A2AServerParts,
} from "../../../src/a2a/server/a2a-server-parts.js";
import { repairedTask } from "../../../src/a2a/tasks/a2a-task-repair.js";
import { onTaskChange, taskChanged, waitedTaskCount } from "../../../src/a2a/tasks/task-changes.js";
import {
  DurableExecutionStatus,
  ExecutionCancelOutcome,
  type ExecutionControl,
} from "../../../src/app/execution-control.js";
import {
  A2ATaskSaveStatus,
  A2ATaskState,
  type A2ATaskRecord,
  type A2ATaskStatus,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");
const KEY = { tenantId: "acme", taskId: "task-1" };
const WORKING: A2ATaskStatus = { state: A2ATaskState.Working, pendingPauses: [] };
const FAILED: A2ATaskStatus = {
  state: A2ATaskState.Failed,
  pendingPauses: [],
  errorCode: "x",
  message: "the task failed: x",
};

async function storeWith(
  status: A2ATaskStatus = { state: A2ATaskState.Submitted, pendingPauses: [] },
) {
  const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
  const save = await tasks.saveIfAbsent({
    ...KEY,
    ownerId: "dana",
    contextId: "ctx-1",
    skill: "s",
    status,
    acceptedAt: NINE,
    messageId: "m-1",
    requestHash: "h",
  });
  if (save.status !== A2ATaskSaveStatus.Saved) throw new Error(save.status);
  return { tasks, task: save.task };
}

const controlAnswering = (status: DurableExecutionStatus): ExecutionControl & { reads: number } => {
  const control = {
    reads: 0,
    executionStateOf: () => {
      control.reads += 1;
      return Promise.resolve({ status } as never);
    },
    cancelExecution: () => Promise.resolve(ExecutionCancelOutcome.AwaitingStart),
    claimExecutionId: () => Promise.resolve(true),
  };
  return control;
};

function partsOf(tasks: InMemoryA2ATaskRepository, control: ExecutionControl, now = NINE) {
  const warnings: string[] = [];
  const clock = new VirtualClock(now);
  const parts: Partial<A2AServerParts> = {
    tasks,
    control,
    clock,
    log: {
      info: () => undefined,
      warn: (code: string, message: string, subject?: unknown) => {
        warnings.push(`${code} ${message} ${JSON.stringify(subject)}`);
      },
      error: () => undefined,
    },
  };
  // what these parts are asked of: the task store, the trees, the clock and the log
  return { parts: parts as A2AServerParts, warnings };
}

describe("#808: a task's waiters in this process", () => {
  it("a change wakes the waiters of that task only — not another task, not another tenant's", () => {
    const woken: string[] = [];
    const stops = [
      onTaskChange(KEY, () => woken.push("task-1")),
      onTaskChange({ tenantId: "acme", taskId: "task-2" }, () => woken.push("task-2")),
      onTaskChange({ tenantId: "other", taskId: "task-1" }, () => woken.push("other")),
      onTaskChange({ tenantId: "acme\u0000task", taskId: "1" }, () => woken.push("joined")),
    ];

    taskChanged(KEY);
    stops.forEach((stop) => {
      stop();
    });

    expect(woken).toEqual(["task-1"]);
  });

  it("one waiter stops, the other is still woken; none left once both stopped", () => {
    const key = { tenantId: "acme", taskId: "task-waited" };
    const woken: string[] = [];
    const before = waitedTaskCount();
    const first = onTaskChange(key, () => woken.push("first"));
    const second = onTaskChange(key, () => woken.push("second"));
    const during = waitedTaskCount();

    first();
    taskChanged(key);
    second();
    taskChanged(key);

    expect(woken).toEqual(["second"]);
    expect(during).toBe(before + 1);
    expect(waitedTaskCount()).toBe(before);
  });
});

describe("#808: the request admitted, as the SDK decodes it", () => {
  const body = (method: unknown, params: unknown) => ({ jsonrpc: "2.0", id: 1, method, params });

  it("each operation with the task it names; ListTasks and a new message name none", () => {
    expect(
      admittedRequestOf(body("SendMessage", { message: { messageId: "m", task_id: "a" } })),
    ).toEqual({
      operation: A2AOperation.SendMessage,
      taskId: "a",
    });
    expect(admittedRequestOf(body("SendStreamingMessage", { message: { taskId: "b" } }))).toEqual({
      operation: A2AOperation.SendStreamingMessage,
      taskId: "b",
    });
    expect(admittedRequestOf(body("SendMessage", {}))).toEqual({
      operation: A2AOperation.SendMessage,
      taskId: "",
    });
    expect(admittedRequestOf(body("SendStreamingMessage", {}))).toEqual({
      operation: A2AOperation.SendStreamingMessage,
      taskId: "",
    });
    expect(admittedRequestOf(body("GetTask", { id: 7 }))?.taskId).toBe("7");
    expect(admittedRequestOf(body("CancelTask", { id: "c" }))?.taskId).toBe("c");
    expect(admittedRequestOf(body("SubscribeToTask", { id: "d" }))?.taskId).toBe("d");
    expect(admittedRequestOf(body("ListTasks", { contextId: "x" }))).toEqual({
      operation: A2AOperation.ListTasks,
      taskId: "",
    });
  });

  it("no operation of a caller: another method, no method, no object params, no object body", () => {
    expect(admittedRequestOf(body("GetExtendedAgentCard", {}))).toBeUndefined();
    expect(admittedRequestOf(body(7, {}))).toBeUndefined();
    expect(admittedRequestOf(body("GetTask", [{ id: "a" }]))).toBeUndefined();
    expect(admittedRequestOf(body("GetTask", null))).toBeUndefined();
    expect(admittedRequestOf(body("GetTask", "a"))).toBeUndefined();
    expect(admittedRequestOf([body("GetTask", { id: "a" })])).toBeUndefined();
    expect(admittedRequestOf(null)).toBeUndefined();
  });

  it("params the SDK cannot decode: none admitted (the transport answers them)", () => {
    // an object as a task id with no text of its own: `String(…)` throws
    const bad = body("GetTask", JSON.parse('{ "id": { "toString": 1, "valueOf": 1 } }'));

    expect(admittedRequestOf(bad)).toBeUndefined();
  });
});

describe("#808: the caller, as the handler reads it", () => {
  const contextOf = (caller: Parameters<typeof callerState>[0], taskId = "t-1") =>
    new ServerCallContext({
      state: callerState(caller, new AbortController().signal, {
        operation: A2AOperation.GetTask,
        taskId,
      }),
    });

  it("the admitted caller, with its tenant (default `default`) and owner", () => {
    const read = callerOf(contextOf({ ownerId: "dana" }), A2AOperation.GetTask, "t-1");

    expect(read).toMatchObject({
      tenantId: "default",
      ownerId: "dana",
      admitted: { taskId: "t-1" },
    });
    expect(
      callerOf(contextOf({ tenant: { tenantId: "acme" } }), A2AOperation.GetTask, "t-1").tenantId,
    ).toBe("acme");
  });

  it("another operation or task than admitted is -32602 a2a.request-mismatch", () => {
    const context = contextOf({ ownerId: "dana" });
    const mismatchOf = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error as { metadata?: { code?: string }; message: string };
      }
      return undefined;
    };

    expect(mismatchOf(() => callerOf(context, A2AOperation.CancelTask, "t-1"))).toMatchObject({
      metadata: { code: "a2a.request-mismatch" },
      message: "the request is not the one its caller was admitted for",
    });
    expect(mismatchOf(() => callerOf(context, A2AOperation.GetTask, "t-2"))?.metadata?.code).toBe(
      "a2a.request-mismatch",
    );
  });

  it("a tenant or an owner that is no key's text is -32602, naming the field and the rule", () => {
    const of = (caller: Parameters<typeof callerState>[0]) => {
      try {
        callerOf(contextOf(caller), A2AOperation.GetTask, "t-1");
      } catch (error) {
        return (error as { metadata?: Record<string, string> }).metadata;
      }
      return undefined;
    };

    const message = (() => {
      try {
        callerOf(contextOf({ tenant: { tenantId: "t\uD800" } }), A2AOperation.GetTask, "t-1");
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    })();
    expect(message).toBe("the caller's tenantId is not a valid id");
    expect(of({ tenant: { tenantId: "t\uD800" } })).toMatchObject({
      code: "a2a.invalid-caller",
      field: "tenantId",
      rule: expect.any(String) as string,
    });
    expect(of({ ownerId: "o\uDFFF" })).toMatchObject({ field: "ownerId" });
    expect(of({ ownerId: "dana" })).toBeUndefined();
  });

  it("a context no binding admitted is a wiring error", () => {
    expect(() => callerOf(new ServerCallContext(), A2AOperation.GetTask)).toThrow(
      "an A2A call without an admitted caller",
    );
  });
});

describe("#808: a caller's task", () => {
  const caller = (ownerId: string) => ({
    caller: { ownerId },
    tenantId: "acme",
    ownerId,
    signal: new AbortController().signal,
    admitted: { operation: A2AOperation.GetTask, taskId: "task-1" },
  });

  it("its own; another owner's, none, an empty or invalid id: not found, the store not asked for the last two", async () => {
    const { tasks } = await storeWith(WORKING);
    let reads = 0;
    const counted = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      findById: (key: typeof KEY) => {
        reads += 1;
        return tasks.findById(key);
      },
    });
    const { parts } = partsOf(counted, controlAnswering(DurableExecutionStatus.Running));
    const code = (run: Promise<unknown>) =>
      run.then(
        () => "found",
        (error: unknown) => (error as { name: string }).name,
      );

    expect((await ownedTask(parts, caller("dana"), "task-1")).taskId).toBe("task-1");
    expect(await code(ownedTask(parts, caller("eve"), "task-1"))).toBe("TaskNotFoundError");
    expect(await code(ownedTask(parts, caller("dana"), "task-2"))).toBe("TaskNotFoundError");
    expect(reads).toBe(3);
    expect(await code(ownedTask(parts, caller("dana"), ""))).toBe("TaskNotFoundError");
    expect(await code(ownedTask(parts, caller("dana"), "x\uD800"))).toBe("TaskNotFoundError");
    expect(reads).toBe(3);
  });

  it("read again from its records only once stale — or at once when forced", async () => {
    const { tasks, task } = await storeWith(WORKING);
    const control = controlAnswering(DurableExecutionStatus.Running);
    const { parts } = partsOf(tasks, control);

    await repairedOf(parts, task);
    const unforced = control.reads;
    await repairedOf(parts, task, true);

    expect(unforced).toBe(0);
    expect(control.reads).toBe(1);
  });

  it("names its tenant and its execution, the task's id, in the log", () => {
    expect(logSubjectOf(KEY)).toEqual({ tenantId: "acme", executionId: "task-1" });
  });
});

describe("#808: a task no execution can start under, ended", () => {
  it("written with its end, its waiters woken; one already over is left as it is", async () => {
    const { tasks, task } = await storeWith();
    const { parts } = partsOf(tasks, controlAnswering(DurableExecutionStatus.NotStarted));
    let woken = 0;
    const stop = onTaskChange(KEY, () => (woken += 1));

    const ended = await endedUnstarted(parts, task, FAILED);
    const again = await endedUnstarted(parts, ended, WORKING);
    stop();

    expect(ended).toMatchObject({ status: FAILED, version: 2 });
    expect(again).toBe(ended);
    expect(woken).toBe(1);
  });

  it("three writes lost to another writer: logged, the task as read; a task swept meanwhile is not found", async () => {
    const { tasks, task } = await storeWith();
    let writes = 0;
    const losing = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      compareAndSetStatus: () => {
        writes += 1;
        return Promise.resolve(undefined);
      },
    });
    const gone = Object.assign(Object.create(losing) as InMemoryA2ATaskRepository, {
      findById: () => Promise.resolve(undefined),
    });
    const lost = partsOf(losing, controlAnswering(DurableExecutionStatus.NotStarted));
    const swept = partsOf(gone, controlAnswering(DurableExecutionStatus.NotStarted));

    const read: A2ATaskRecord = await endedUnstarted(lost.parts, task, FAILED);

    expect(read.status.state).toBe(A2ATaskState.Submitted);
    expect(lost.warnings).toEqual([
      `a2a.task-write-contended task task-1 changed 3 times under its end: left to its read repair ${JSON.stringify({ tenantId: "acme", executionId: "task-1" })}`,
    ]);
    expect(writes).toBe(3);
    await expect(endedUnstarted(swept.parts, task, FAILED)).rejects.toMatchObject({
      name: "TaskNotFoundError",
    });
  });
});

describe("#808: a read repair wakes the task's waiters when it writes", () => {
  const repairParts = (tasks: InMemoryA2ATaskRepository, control: ExecutionControl) => ({
    tasks,
    control,
    clock: { now: () => new Date(NINE.getTime() + 60_000) },
    staleAfter: seconds(30),
    startTimeout: seconds(60),
  });

  it("a write wakes them once; a write another writer won wakes none", async () => {
    const written = await storeWith(WORKING);
    const lost = await storeWith(WORKING);
    const losing = Object.assign(Object.create(lost.tasks) as InMemoryA2ATaskRepository, {
      compareAndSetStatus: () => Promise.resolve(undefined),
    });
    const control = controlAnswering(DurableExecutionStatus.Cancelled);
    let woken = 0;
    const stop = onTaskChange(KEY, () => (woken += 1));

    const repaired = await repairedTask(repairParts(written.tasks, control), written.task);
    const unwritten = await repairedTask(repairParts(losing, control), lost.task);
    stop();

    expect(repaired.status.state).toBe(A2ATaskState.Canceled);
    expect(unwritten.status.state).toBe(A2ATaskState.Working);
    expect(woken).toBe(1);
  });
});
