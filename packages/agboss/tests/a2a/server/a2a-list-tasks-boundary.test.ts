/**
 * #960 AC4 — `statusTimestampAfter` keeps a status at or after the time asked (a2a.proto: "greater
 * than or equal to"), on every core store, at the exact millisecond: a status written at the time
 * is listed, one a millisecond before it is not, and a fraction below the millisecond rounds up to
 * the next one. The stores keep the strict bound of the store contract, which the server moves.
 */
import { TaskState, type ListTasksRequest } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { listedTasks } from "../../../src/a2a/server/a2a-list-tasks.js";
import {
  A2ATaskState,
  type A2ATaskRepository,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { SqliteA2ATaskRepository } from "../../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { connectionTo, temporarySqlitePath } from "../../infrastructure/contracts/store-kinds.js";
import { callerOf, savedTask, scriptOf, unitParts } from "./support/unit-parts.js";

const DONE = { state: A2ATaskState.Completed, pendingPauses: [] };
const AT = Date.parse("2026-01-05T09:00:00.000Z");

const stores: readonly (readonly [string, () => A2ATaskRepository])[] = [
  ["in-memory", () => new InMemoryA2ATaskRepository(new InMemoryDatabase())],
  ["SQLite", () => new SqliteA2ATaskRepository(connectionTo(temporarySqlitePath()))],
];

/** The status times `ListTasks` gives for `after`. */
async function listedAfter(tasks: A2ATaskRepository, after: string): Promise<readonly string[]> {
  const request: ListTasksRequest = {
    tenant: "",
    contextId: "",
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageSize: undefined,
    pageToken: "",
    historyLength: undefined,
    statusTimestampAfter: after,
    includeArtifacts: undefined,
  };
  const page = await listedTasks(unitParts(scriptOf(), tasks), callerOf(), request);
  expect(page.totalSize).toBe(page.tasks.length);
  return page.tasks.map((task) => task.status?.timestamp ?? "").sort();
}

/** A store of three tasks finished at :00.000, :00.001 and :00.002. */
async function threeTasks(tasks: A2ATaskRepository): Promise<A2ATaskRepository> {
  for (const ms of [0, 1, 2]) {
    const task = await savedTask(tasks, {
      taskId: `task-${String(ms)}`,
      messageId: `m-${String(ms)}`,
    });
    await tasks.compareAndSetStatus(task, task.version, DONE, new Date(AT + ms));
  }
  return tasks;
}

describe.each(stores)("#960 AC4: statusTimestampAfter's boundary on %s", (_name, newStore) => {
  it("a task whose status is at the time asked is listed, one a millisecond before is not", async () => {
    const tasks = await threeTasks(newStore());

    expect(await listedAfter(tasks, "2026-01-05T09:00:00.001Z")).toEqual([
      "2026-01-05T09:00:00.001Z",
      "2026-01-05T09:00:00.002Z",
    ]);
    expect(await listedAfter(tasks, "2026-01-05T09:00:00.000Z")).toHaveLength(3);
    expect(await listedAfter(tasks, "2026-01-05T09:00:00.003Z")).toEqual([]);
  });

  it("a fraction below the millisecond rounds up to the next one; an offset is the same instant", async () => {
    const tasks = await threeTasks(newStore());

    expect(await listedAfter(tasks, "2026-01-05T09:00:00.0015Z")).toEqual([
      "2026-01-05T09:00:00.002Z",
    ]);
    expect(await listedAfter(tasks, "2026-01-05T11:00:00.001+02:00")).toHaveLength(2);
  });
});
