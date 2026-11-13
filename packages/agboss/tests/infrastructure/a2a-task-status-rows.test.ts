/**
 * #960 AC3 on SQLite: a status column is read through its schema — a corrupt one (a field of the
 * wrong type, one missing, a state no task has) is refused, never read as a task's state — and a
 * key this version does not know is read back as written, never dropped.
 */
import { describe, expect, it } from "vitest";
import { A2ATaskState } from "../../src/infrastructure/a2a-task.repository.js";
import { SqliteA2ATaskRepository } from "../../src/infrastructure/sqlite/sqlite-a2a-task.repository.js";
import { PauseKind } from "../../src/pause/types.js";
import { newTask } from "../../src/testing/contracts/a2a-task-data.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const KEY = { tenantId: "default", taskId: "t-1" };

/** A store whose task `t-1` has `status` written into its column as it is. */
async function withStatus(status: unknown): Promise<SqliteA2ATaskRepository> {
  const connection = connectionTo(temporarySqlitePath());
  const tasks = new SqliteA2ATaskRepository(connection);
  await tasks.saveIfAbsent(newTask("t-1"));
  connection.database
    .prepare("UPDATE a2a_tasks SET state = ?, status = ?")
    .run(A2ATaskState.Working, JSON.stringify(status));
  return tasks;
}

const WORKING = { state: A2ATaskState.Working, pendingPauses: [] };

describe("#960 AC3: the status column of the SQLite A2A task store", () => {
  it("a key this version does not know is read back as written", async () => {
    const status = { ...WORKING, grantedUsd: { n: 5 } };

    expect((await (await withStatus(status)).findById(KEY))?.status).toEqual(status);
  });

  it("a key this version does not know inside a pending pause is read back as written", async () => {
    const pause = { pauseId: "p-1", kind: PauseKind.Approval, ask: { q: 1 }, grantedBy: { n: 5 } };
    const status = { ...WORKING, pendingPauses: [pause] };

    expect((await (await withStatus(status)).findById(KEY))?.status).toEqual(status);
  });

  it.each([
    ["its pauses missing", { state: A2ATaskState.Working }],
    ["a spend that is no number", { ...WORKING, spentUsd: "3" }],
    ["a negative spend", { ...WORKING, spentUsd: -1 }],
    ["a state no task has", { state: "TASK_STATE_LOST", pendingPauses: [] }],
    ["a cancel time that is none", { ...WORKING, cancelRequestedAt: "soon" }],
    ["a pause of a kind no pause has", { ...WORKING, pendingPauses: [{ kind: "wish", ask: 1 }] }],
    [
      "a pause whose id is no text",
      { ...WORKING, pendingPauses: [{ pauseId: 1, kind: PauseKind.Question, ask: 1 }] },
    ],
  ])("a status with %s is refused, never read", async (_name, status) => {
    await expect((await withStatus(status)).findById(KEY)).rejects.toThrow();
  });
});
