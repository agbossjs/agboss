import { Injectable } from "../components/decorators.js";
import {
  A2ATaskRepository,
  A2ATaskSaveStatus,
  firstA2AMessageOf,
  isTerminalA2ATaskState,
  savedA2ATaskOf,
  type A2AMessageKey,
  type A2AMessageRecord,
  type A2ATaskKey,
  type A2ATaskPage,
  type A2ATaskQuery,
  type A2ATaskRecord,
  type A2ATaskSave,
  type A2ATaskStatus,
  type NewA2ATask,
} from "./a2a-task.repository.js";
import { a2aMessageRowOf, a2aPageOf, a2aTaskRowOf, byNewestStatus } from "./a2a-task-pages.js";
import { IN_MEMORY_DATABASE, type InMemoryDatabase } from "./in-memory-database.js";
import { DIRECT_MESSAGE_CLAIM } from "./in-memory-a2a-direct-message.repository.js";
import type { StoreDescriptor } from "./execution-lease.repository.js";

/** A status kept as plain JSON, as the SQLite store keeps it: one comparison for both (L1). */
const asStored = (status: A2ATaskStatus): A2ATaskStatus =>
  JSON.parse(JSON.stringify(status)) as A2ATaskStatus;

/** The built-in default: the tasks in this instance's memory, a copy of each in and out. */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class InMemoryA2ATaskRepository extends A2ATaskRepository {
  static override readonly store: StoreDescriptor = { backend: "in-memory" };

  constructor(private readonly database: InMemoryDatabase) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  saveIfAbsent(task: NewA2ATask): Promise<A2ATaskSave> {
    const { a2aTasks: tasks, a2aMessages: messages } = this.database;
    const kept = messages.get(a2aMessageRowOf(task));
    if (kept !== undefined) {
      const found = tasks.get(a2aTaskRowOf({ tenantId: kept.tenantId, taskId: kept.taskId }));
      return Promise.resolve({
        status: A2ATaskSaveStatus.MessageTaken,
        message: structuredClone(kept),
        task: structuredClone(found),
      });
    }
    if (tasks.has(a2aTaskRowOf(task)))
      return Promise.resolve({ status: A2ATaskSaveStatus.TaskIdTaken });
    const saved = savedA2ATaskOf({ ...task, status: asStored(task.status) });
    tasks.set(a2aTaskRowOf(task), structuredClone(saved));
    messages.set(a2aMessageRowOf(task), firstA2AMessageOf(structuredClone(task)));
    return Promise.resolve({ status: A2ATaskSaveStatus.Saved, task: structuredClone(saved) });
  }

  saveMessageIfAbsent(message: A2AMessageRecord): Promise<A2AMessageRecord | undefined> {
    const row = a2aMessageRowOf(message);
    const kept = this.database.a2aMessages.get(row);
    if (kept !== undefined) return Promise.resolve(structuredClone(kept));
    this.database.a2aMessages.set(row, structuredClone(message));
    return Promise.resolve(undefined);
  }

  saveReplyIfAbsent(key: A2AMessageKey, reply: unknown): Promise<boolean> {
    const row = a2aMessageRowOf(key);
    const kept = this.database.a2aMessages.get(row);
    if (kept === undefined || kept.reply !== undefined) return Promise.resolve(false);
    this.database.a2aMessages.set(row, { ...kept, reply: structuredClone(reply) });
    return Promise.resolve(true);
  }

  findById(key: A2ATaskKey): Promise<A2ATaskRecord | undefined> {
    const task = this.database.a2aTasks.get(a2aTaskRowOf(key));
    return Promise.resolve(structuredClone(task));
  }

  findByMessage(key: A2AMessageKey): Promise<A2AMessageRecord | undefined> {
    const message = this.database.a2aMessages.get(a2aMessageRowOf(key));
    return Promise.resolve(structuredClone(message));
  }

  compareAndSetStatus(
    key: A2ATaskKey,
    expectedVersion: number,
    status: A2ATaskStatus,
    statusAt: Date,
  ): Promise<A2ATaskRecord | undefined> {
    const row = a2aTaskRowOf(key);
    const task = this.database.a2aTasks.get(row);
    if (task?.version !== expectedVersion || isTerminalA2ATaskState(task.status.state))
      return Promise.resolve(undefined);
    const written = {
      ...task,
      status: asStored(status),
      version: task.version + 1,
      statusAt,
    };
    this.database.a2aTasks.set(row, written);
    return Promise.resolve(structuredClone(written));
  }

  list(query: A2ATaskQuery): Promise<A2ATaskPage> {
    // a refused page token rejects the call, never throws
    return new Promise((resolve) => {
      resolve(this.#page(query));
    });
  }

  #page(query: A2ATaskQuery): A2ATaskPage {
    const matching = [...this.database.a2aTasks.values()]
      .filter(
        (task) =>
          task.tenantId === query.tenantId &&
          task.ownerId === query.ownerId &&
          (query.contextId === undefined || task.contextId === query.contextId) &&
          (query.state === undefined || task.status.state === query.state) &&
          (query.statusAtAfter === undefined || task.statusAt > query.statusAtAfter),
      )
      .sort(byNewestStatus);
    return structuredClone(a2aPageOf(matching, query));
  }

  deleteTerminalByStatusAtBefore(cutoff: Date): Promise<void> {
    const { a2aTasks: tasks, a2aMessages: messages } = this.database;
    const gone = new Set<string>();
    for (const [row, task] of tasks) {
      if (!isTerminalA2ATaskState(task.status.state) || task.statusAt >= cutoff) continue;
      tasks.delete(row);
      gone.add(row);
    }
    for (const [row, message] of messages) {
      const task = a2aTaskRowOf({ tenantId: message.tenantId, taskId: message.taskId });
      // a task's own messages go with it; one whose task is gone is an orphan (#960), swept by its age
      // a direct message's claim has no task by design (#860): never an orphan
      const isOrphan =
        message.taskId !== DIRECT_MESSAGE_CLAIM && !tasks.has(task) && message.savedAt < cutoff;
      if (gone.has(task) || isOrphan) messages.delete(row);
    }
    return Promise.resolve();
  }
}
