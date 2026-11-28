/**
 * #1356 (mutation shard `a2a-tasks`): the cancel time a SQLite task's status column holds is read back
 * as a `Date`, as the in-memory store reads it.
 */
import { expect, it } from "vitest";
import { A2ATaskState } from "../../src/infrastructure/a2a-task.repository.js";
import { SqliteA2ATaskRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { newTask } from "../../src/testing/contracts/a2a-task-data.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

it("a status written with its cancel time reads it back as that Date", async () => {
  const connection = connectionTo(temporarySqlitePath());
  const tasks = new SqliteA2ATaskRepository(connection);
  await tasks.saveIfAbsent(newTask("t-1"));
  const status = {
    state: A2ATaskState.Working,
    pendingPauses: [],
    cancelRequestedAt: "2026-01-05T09:00:00.000Z",
  };
  connection.database
    .prepare("UPDATE a2a_tasks SET state = ?, status = ?")
    .run(A2ATaskState.Working, JSON.stringify(status));

  const read = await tasks.findById({ tenantId: "default", taskId: "t-1" });

  expect(read?.status.cancelRequestedAt).toEqual(new Date("2026-01-05T09:00:00.000Z"));
});
