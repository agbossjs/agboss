/**
 * #824 (mutation shard `a2a-server`): `ListTasks` on its own — the store is asked exactly the
 * filters the request gives, its count and token passed on; the page size's bounds, an unknown
 * state, a time that is none and a token the store refused are `-32602` with fixed texts; a store's
 * other failure is its own; artifacts only when asked.
 */
import { TaskState, type ListTasksRequest } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { listedTasks } from "../../../src/a2a/server/a2a-list-tasks.js";
import {
  A2ATaskState,
  type A2ATaskPage,
  type A2ATaskQuery,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { callerOf, refusalOf, savedTask, scriptOf, unitParts } from "./support/unit-parts.js";

const request = (fields: Partial<ListTasksRequest> = {}): ListTasksRequest => ({
  tenant: "",
  contextId: "",
  status: TaskState.TASK_STATE_UNSPECIFIED,
  pageSize: undefined,
  pageToken: "",
  historyLength: undefined,
  statusTimestampAfter: undefined,
  includeArtifacts: undefined,
  ...fields,
});

const COMPLETED = {
  state: A2ATaskState.Completed,
  pendingPauses: [],
  finish: "unit-workflow-finish",
  output: { orderId: "o-1" },
};

/** A store that records each query and answers `page`, or throws `error`. */
function recordingStore(queries: A2ATaskQuery[], answer: A2ATaskPage | Error) {
  const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
  return Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
    list: (query: A2ATaskQuery) => {
      queries.push(query);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  });
}

const EMPTY: A2ATaskPage = { tasks: [], nextPageToken: "next", totalSize: 7 };

describe("#824: ListTasks", () => {
  it("asks the store exactly the filters given, and passes its token and count on", async () => {
    const queries: A2ATaskQuery[] = [];
    const parts = unitParts(scriptOf(), recordingStore(queries, EMPTY));

    const none = await listedTasks(parts, callerOf(), request());
    await listedTasks(
      parts,
      callerOf(),
      request({
        contextId: "ctx-1",
        status: TaskState.TASK_STATE_WORKING,
        statusTimestampAfter: "2026-01-05T09:00:00Z",
        pageSize: 3,
        pageToken: "t",
      }),
    );

    expect(none).toEqual({ tasks: [], nextPageToken: "next", pageSize: 50, totalSize: 7 });
    expect(queries).toStrictEqual([
      { tenantId: "acme", ownerId: "dana", pageSize: 50, pageToken: "" },
      {
        tenantId: "acme",
        ownerId: "dana",
        contextId: "ctx-1",
        state: A2ATaskState.Working,
        statusAtAfter: new Date("2026-01-05T09:00:00Z"),
        pageSize: 3,
        pageToken: "t",
      },
    ]);
  });

  it("a page size of 1 to 100 is asked; 0, 101 and 1.5 are -32602", async () => {
    const queries: A2ATaskQuery[] = [];
    const parts = unitParts(scriptOf(), recordingStore(queries, EMPTY));
    const sized = (pageSize: number) =>
      refusalOf(listedTasks(parts, callerOf(), request({ pageSize })));
    const refused = "RequestMalformedError a2a.page-size: pageSize is a whole number from 1 to 100";

    expect([await sized(1), await sized(100)]).toEqual(["resolved", "resolved"]);
    expect([await sized(0), await sized(101), await sized(1.5)]).toEqual([
      refused,
      refused,
      refused,
    ]);
    expect(queries.map(({ pageSize }) => pageSize)).toEqual([1, 100]);
  });

  it("an unknown state, a time that is none, a token the store refused: -32602, fixed texts", async () => {
    const parts = unitParts(scriptOf());
    const of = (fields: Partial<ListTasksRequest>) =>
      refusalOf(listedTasks(parts, callerOf(), request(fields)));

    expect(await of({ status: 99 as TaskState })).toBe(
      "RequestMalformedError a2a.unknown-state: no such task state",
    );
    expect(await of({ statusTimestampAfter: "yesterday" })).toBe(
      "RequestMalformedError a2a.invalid-timestamp: statusTimestampAfter is not an RFC 3339 time",
    );
    expect(await of({ pageToken: "forged" })).toBe(
      "RequestMalformedError a2a.invalid-page-token: the page token is not one this agent gave",
    );
  });

  it("a store's other failure is its own, not a refusal", async () => {
    const broken = new Error("the store is down");
    const parts = unitParts(scriptOf(), recordingStore([], broken));

    await expect(listedTasks(parts, callerOf(), request())).rejects.toBe(broken);
  });

  it("a completed task's artifact only when asked for", async () => {
    const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
    await savedTask(tasks, {}, COMPLETED);
    const parts = unitParts(scriptOf(), tasks);

    const without = await listedTasks(parts, callerOf(), request());
    const asked = await listedTasks(parts, callerOf(), request({ includeArtifacts: true }));
    const declined = await listedTasks(parts, callerOf(), request({ includeArtifacts: false }));

    expect(without.tasks[0]?.artifacts).toStrictEqual([]);
    expect(declined.tasks[0]?.artifacts).toStrictEqual([]);
    expect(asked.tasks[0]?.artifacts).toHaveLength(1);
    expect(asked.tasks[0]?.artifacts[0]?.name).toBe("unit-workflow-finish");
  });
});
