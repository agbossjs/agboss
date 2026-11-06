/**
 * #824 (mutation shard `a2a-server`): a new message's accept on its own — the task saved as
 * submitted with the caller's peer, its execution started under the task's id with exactly the
 * caller's options, once per process; a resend that finds its task (started again only while
 * submitted), one with other content, one whose task is gone; a minted id taken (the next one,
 * three at most); a start the app refused (fenced and ended, unless another start or an execution
 * has the id).
 */
import { describe, expect, it } from "vitest";
import { acceptedTask } from "../../../src/a2a/server/a2a-accept.js";
import { reservedExecutionIdOf } from "../../../src/app/tree-control.js";
import { DurableExecutionStatus } from "../../../src/app/execution-control.js";
import { AGBossError, DuplicateExecutionIdError } from "../../../src/core/errors.js";
import {
  A2ATaskSaveStatus,
  A2ATaskState,
  type NewA2ATask,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { seconds } from "../../../src/units/index.js";
import {
  callerOf,
  messageOf,
  NINE,
  refusalOf,
  scriptOf,
  settle,
  SUBMITTED,
  unitParts,
  UnitWorkflowStart,
  WORKING,
} from "./support/unit-parts.js";

class RefusedStartError extends AGBossError {
  static override readonly code: string = "budget.refused";
}

const newTasks = () => new InMemoryA2ATaskRepository(new InMemoryDatabase());
const hello = (contextId = "") => messageOf("m-1", ["hello"], { contextId });

describe("#824: a new message's task", () => {
  it("saved submitted under a minted id, with the caller's peer; started with exactly the caller's options", async () => {
    const script = scriptOf();
    const parts = unitParts(script, newTasks(), { maxTaskDuration: seconds(90) });
    const caller = callerOf({
      caller: {
        ownerId: "dana",
        peer: "orders-application",
        tenant: { tenantId: "acme" },
        execution: { userId: "u-1" },
      },
    });

    const task = await acceptedTask(parts, caller, hello("ctx-7"));
    await settle();

    expect(task).toMatchObject({
      contextId: "ctx-7",
      callerPeer: "orders-application",
      version: 1,
    });
    expect(task.status).toStrictEqual(SUBMITTED);
    const [run] = script.executions;
    expect([script.executions.length, run?.start, run?.input]).toEqual([
      1,
      UnitWorkflowStart,
      { text: "hello" },
    ]);
    expect(Object.keys(run?.options ?? {}).sort()).toEqual(
      ["deadline", "execution", "onStream", "ownerId", "tenant", "threadId"].sort(),
    );
    expect(run?.options).toMatchObject({
      threadId: "ctx-7",
      tenant: { tenantId: "acme" },
      ownerId: "dana",
      execution: { userId: "u-1" },
      deadline: seconds(90),
    });
    expect(reservedExecutionIdOf(run?.options ?? {})).toBe(task.taskId);
  });

  it("a caller with nothing but itself: no peer, no tenant, owner or values, no deadline; a context minted", async () => {
    const script = scriptOf();
    const caller = callerOf({ caller: {}, ownerId: undefined });

    const tasks = newTasks();
    const saved: NewA2ATask[] = [];
    const recording = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      saveIfAbsent: (task: NewA2ATask) => {
        saved.push(task);
        return tasks.saveIfAbsent(task);
      },
    });

    const task = await acceptedTask(unitParts(script, recording), caller, hello());
    await settle();

    expect("callerPeer" in task).toBe(false);
    expect(saved.map((one) => "callerPeer" in one)).toEqual([false]);
    expect(task.contextId).toBe("minted-thread");
    expect(Object.keys(script.executions[0]?.options ?? {})).toEqual(["threadId", "onStream"]);
  });

  it("a context or a message id that is no key's text is -32602, naming the field", async () => {
    const parts = unitParts(scriptOf(), newTasks());

    expect(await refusalOf(acceptedTask(parts, callerOf(), hello("c\uD800")))).toBe(
      "RequestMalformedError a2a.invalid-id: contextId is not a valid id",
    );
    expect(await refusalOf(acceptedTask(parts, callerOf(), messageOf("m\uD800", ["x"])))).toBe(
      "RequestMalformedError a2a.invalid-id: messageId is not a valid id",
    );
  });
});

describe("#824: a message sent again", () => {
  it("while its run here goes on: the same task, no second run, no second id minted", async () => {
    let release = (): void => undefined;
    const script = scriptOf({ hold: new Promise<void>((resolve) => (release = resolve)) });
    const parts = unitParts(script, newTasks());

    const first = await acceptedTask(parts, callerOf(), hello());
    const again = await acceptedTask(parts, callerOf(), hello());
    release();
    await settle();

    expect(again.taskId).toBe(first.taskId);
    expect(script.executions).toHaveLength(1);
    expect(script.calls.filter((call) => call.startsWith("mint"))).toHaveLength(1);
  });

  it("its task still submitted (the first start lost): started again under the same id; one that runs: not", async () => {
    const tasks = newTasks();
    const script = scriptOf();
    const parts = unitParts(script, tasks);
    const first = await acceptedTask(parts, callerOf(), hello());
    await settle();

    await acceptedTask(parts, callerOf(), hello());
    await settle();
    await tasks.compareAndSetStatus(first, 1, WORKING, NINE);
    await acceptedTask(parts, callerOf(), hello());
    await settle();

    expect(script.executions.map(({ options }) => reservedExecutionIdOf(options))).toEqual([
      first.taskId,
      first.taskId,
    ]);
  });

  it("with other content: -32602; its task swept: not found", async () => {
    const tasks = newTasks();
    const parts = unitParts(scriptOf(), tasks);
    const task = await acceptedTask(parts, callerOf(), hello());
    const gone = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      findById: () => Promise.resolve(undefined),
    });

    expect(await refusalOf(acceptedTask(parts, callerOf(), messageOf("m-1", ["bye"])))).toBe(
      "RequestMalformedError a2a.message-id-reused: messageId reused with different content",
    );
    expect(await refusalOf(acceptedTask(unitParts(scriptOf(), gone), callerOf(), hello()))).toBe(
      "TaskNotFoundError: task not found",
    );
    expect(task.taskId).toMatch(/^minted-/u);
  });
});

describe("#824: a minted id another task has", () => {
  /** A store whose first `taken` saves find the minted id taken. */
  const takingStore = (taken: number) => {
    const tasks = newTasks();
    let saves = 0;
    return Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
      saveIfAbsent: (task: NewA2ATask) => {
        saves += 1;
        return saves <= taken
          ? Promise.resolve({ status: A2ATaskSaveStatus.TaskIdTaken })
          : tasks.saveIfAbsent(task);
      },
    });
  };

  it("the next one is minted; the third taken is the request failed", async () => {
    const once = scriptOf();
    const thrice = scriptOf();

    const task = await acceptedTask(unitParts(once, takingStore(1)), callerOf(), hello());
    const failed = await refusalOf(
      acceptedTask(unitParts(thrice, takingStore(3)), callerOf(), hello()),
    );

    expect(once.calls.filter((call) => call.startsWith("mint"))).toHaveLength(2);
    expect(task.status.state).toBe(A2ATaskState.Submitted);
    expect(failed).toBe("A2AInternalError: the request failed");
    expect(thrice.calls.filter((call) => call.startsWith("mint"))).toHaveLength(3);
  });
});

describe("#824: a start the app refused", () => {
  const refusedWith = async (runError: Error, state = DurableExecutionStatus.NotStarted) => {
    const tasks = newTasks();
    const script = scriptOf({ runError, state: { status: state } as never });
    const task = await acceptedTask(unitParts(script, tasks), callerOf(), hello());
    await settle();
    return { script, read: await tasks.findById(task) };
  };

  it("before its execution began: fenced, then FAILED with the refusal's code", async () => {
    const { script, read } = await refusedWith(new DuplicateExecutionIdError("G"));
    const refused = await refusedWith(Object.assign(new Error("x"), { name: "BudgetError" }));

    expect(script.calls.filter((call) => call.startsWith("claim"))).toEqual([]);
    expect(read?.status).toStrictEqual(SUBMITTED);
    expect(refused.script.calls).toContain(`claim ${refused.read?.taskId ?? ""}`);
    expect(refused.read?.status).toMatchObject({
      state: A2ATaskState.Failed,
      errorCode: "internal",
    });
    const coded = await refusedWith(new RefusedStartError("no budget"));
    expect(coded.read?.status).toMatchObject({
      state: A2ATaskState.Failed,
      errorCode: "budget.refused",
    });
  });

  it("an execution that began under the id: its records end it, the task is left", async () => {
    const { read } = await refusedWith(new Error("x"), DurableExecutionStatus.Running);

    expect(read?.status).toStrictEqual(SUBMITTED);
  });
});
