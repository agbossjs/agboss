/**
 * #1356 (mutation shards `a2a-tasks`, `a2a-server`): who a request acts as — a task's owner made for a
 * caller that named none (`forNewTask`), the id as the right to a task (`forTask`), the task of one
 * endpoint only (`ownedTask`).
 */
import { describe, expect, it } from "vitest";
import {
  forNewTask,
  forTask,
  isTaskOwner,
  ownedTask,
  TASK_OWNER_PREFIX,
} from "../../../src/a2a/server/a2a-server-parts.js";
import { A2AOperation } from "../../../src/a2a/a2a-caller.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import {
  callerOf,
  refusalOf,
  savedTask,
  scriptOf,
  unitParts,
  UNIT_ENDPOINT,
} from "./support/unit-parts.js";

/** A task store that counts its reads by id. */
function countedTasks() {
  const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
  const reads: string[] = [];
  const counted = Object.assign(Object.create(tasks) as InMemoryA2ATaskRepository, {
    findById: (key: { tenantId: string; taskId: string }) => {
      reads.push(key.taskId);
      return tasks.findById(key);
    },
  });
  return { tasks, counted, reads };
}

const anonymous = () =>
  callerOf(
    { ownerId: undefined, caller: { rateLimitKey: "key-1", peer: "peer-app" } },
    A2AOperation.GetTask,
  );

describe("forNewTask: a caller that names no owner gets one of its own", () => {
  it("the owner is a fresh `a2a-task:` one, on the request and on the caller its run takes, the caller's other values kept", () => {
    const request = anonymous();

    const made = forNewTask(request);

    expect(made.ownerId).toMatch(/^a2a-task:[0-9a-f-]{36}$/u);
    expect(isTaskOwner(made.ownerId)).toBe(true);
    expect(made.caller).toEqual({
      rateLimitKey: "key-1",
      peer: "peer-app",
      ownerId: made.ownerId,
    });
    expect(made.tenantId).toBe("acme");
    expect(forNewTask(request).ownerId).not.toBe(made.ownerId);
  });

  it("a caller with an owner is the same request", () => {
    const request = callerOf();

    expect(forNewTask(request)).toBe(request);
  });
});

describe("isTaskOwner: only the owners this path made", () => {
  it.each([
    [`${TASK_OWNER_PREFIX}x`, true],
    ["anonymous:x", false],
    ["mcp-session:x", false],
    [undefined, false],
  ])("%s → %s", (ownerId, expected) => {
    expect(isTaskOwner(ownerId)).toBe(expected);
  });
});

describe("forTask: the task's id is the right to it for a caller with no owner", () => {
  it("acts as the owner of a task this path made for its endpoint", async () => {
    const { tasks, counted, reads } = countedTasks();
    await savedTask(tasks, { ownerId: "a2a-task:abc" });
    const parts = unitParts(scriptOf(), counted);
    const request = anonymous();

    const acting = await forTask(parts, request, "task-1");

    expect(reads).toEqual(["task-1"]);
    expect(acting.ownerId).toBe("a2a-task:abc");
    expect(acting.caller).toEqual({
      rateLimitKey: "key-1",
      peer: "peer-app",
      ownerId: "a2a-task:abc",
    });
    expect(acting.admitted).toBe(request.admitted);
  });

  it("a caller with an owner keeps it and the store is not read, even for a task made for none", async () => {
    const { tasks, counted, reads } = countedTasks();
    await savedTask(tasks, { ownerId: "a2a-task:abc" });
    const parts = unitParts(scriptOf(), counted);
    const request = callerOf();

    const acting = await forTask(parts, request, "task-1");

    expect(acting).toBe(request);
    expect(reads).toEqual([]);
  });

  it("an id that is no key's text names no task: the store is not read", async () => {
    const { tasks, counted, reads } = countedTasks();
    await savedTask(tasks, { ownerId: "a2a-task:abc" });
    const parts = unitParts(scriptOf(), counted);
    const request = anonymous();

    expect(await forTask(parts, request, "")).toBe(request);
    expect(await forTask(parts, request, "x\uD800")).toBe(request);
    expect(reads).toEqual([]);
  });

  it.each([
    ["a task of another endpoint", { ownerId: "a2a-task:abc", endpoint: "other-endpoint" }],
    ["a task of an `anonymous:` owner", { ownerId: "anonymous:abc" }],
    ["a task of an `mcp-session:` owner", { ownerId: "mcp-session:abc" }],
    ["a task of a named owner", { ownerId: "dana" }],
  ])("%s is not reached by its id", async (_name, overrides) => {
    const { tasks, counted } = countedTasks();
    await savedTask(tasks, overrides);
    const parts = unitParts(scriptOf(), counted);
    const request = anonymous();

    expect(await forTask(parts, request, "task-1")).toBe(request);
  });

  it("an unknown task is not reached either", async () => {
    const { counted } = countedTasks();
    const request = anonymous();

    expect(await forTask(unitParts(scriptOf(), counted), request, "task-9")).toBe(request);
  });
});

describe("ownedTask: a task of this endpoint only", () => {
  it("another endpoint's task of the same tenant, id and owner is not found", async () => {
    const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
    await savedTask(tasks, { endpoint: "other-endpoint" });
    const parts = unitParts(scriptOf(), tasks);
    expect(parts.endpoint).toBe(UNIT_ENDPOINT);

    expect(await refusalOf(ownedTask(parts, callerOf(), "task-1"))).toMatch(/^TaskNotFoundError/u);
  });
});
