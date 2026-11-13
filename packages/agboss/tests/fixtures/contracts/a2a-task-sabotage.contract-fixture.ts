// #807 — the A2A task contract run on the sound in-memory store and on one broken way per rule;
// tests/testing/contracts/a2a-task-sabotage.test.ts reads which cases each fails.
import {
  A2ATaskSaveStatus,
  firstA2AMessageOf,
  savedA2ATaskOf,
  type A2ATaskKey,
  type A2ATaskPage,
  type A2ATaskQuery,
  type A2ATaskRecord,
  type A2ATaskSave,
  type A2ATaskStatus,
  type NewA2ATask,
} from "../../../src/infrastructure/a2a-task.repository.js";
import { a2aMessageRowOf, a2aTaskRowOf } from "../../../src/infrastructure/a2a-task-pages.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import type { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { a2aTaskContract } from "../../../src/testing/contracts/index.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";

type Broken = new (database: InMemoryDatabase) => InMemoryA2ATaskRepository;

const target = (name: string, Store: Broken) => ({
  ...inMemoryTarget(({ database }) => new Store(database)),
  name,
});

/** Looks the message up, then writes after a round trip: two instances both save. */
class CheckThenWrite extends InMemoryA2ATaskRepository {
  override async saveIfAbsent(task: NewA2ATask): Promise<A2ATaskSave> {
    if ((await this.findByMessage(task)) !== undefined) return super.saveIfAbsent(task);
    await Promise.resolve();
    const database = Reflect.get(this, "database") as InMemoryDatabase;
    const saved = savedA2ATaskOf(task);
    database.a2aTasks.set(a2aTaskRowOf(task), saved);
    database.a2aMessages.set(a2aMessageRowOf(task), firstA2AMessageOf(task));
    return { status: A2ATaskSaveStatus.Saved, task: saved };
  }
}

/** Writes whatever the version: a stale writer lands. */
class IgnoresVersion extends InMemoryA2ATaskRepository {
  override async compareAndSetStatus(
    key: A2ATaskKey,
    _expected: number,
    status: A2ATaskStatus,
    statusAt: Date,
  ): Promise<A2ATaskRecord | undefined> {
    const task = await this.findById(key);
    return task === undefined
      ? undefined
      : super.compareAndSetStatus(key, task.version, status, statusAt);
  }
}

/** Overwrites a terminal status at its version. */
class OverwritesTerminal extends InMemoryA2ATaskRepository {
  override compareAndSetStatus(
    key: A2ATaskKey,
    expected: number,
    status: A2ATaskStatus,
    statusAt: Date,
  ): Promise<A2ATaskRecord | undefined> {
    const database = Reflect.get(this, "database") as InMemoryDatabase;
    const row = a2aTaskRowOf(key);
    const task = database.a2aTasks.get(row);
    if (task?.version !== expected) return Promise.resolve(undefined);
    const written = { ...task, status, version: task.version + 1, statusAt };
    database.a2aTasks.set(row, written);
    return Promise.resolve(structuredClone(written));
  }
}

/** Lists in the order saved, oldest first. */
class Unsorted extends InMemoryA2ATaskRepository {
  override async list(query: A2ATaskQuery): Promise<A2ATaskPage> {
    const page = await super.list({ ...query, pageSize: 1000, pageToken: "" });
    const tasks = [...page.tasks].reverse().slice(0, query.pageSize);
    return { tasks, nextPageToken: "", totalSize: page.totalSize };
  }
}

/** Removes every task older than the cutoff, finished or not. */
class SweepsUnfinished extends InMemoryA2ATaskRepository {
  override deleteTerminalByStatusAtBefore(cutoff: Date): Promise<void> {
    const database = Reflect.get(this, "database") as InMemoryDatabase;
    for (const [row, task] of database.a2aTasks)
      if (task.statusAt < cutoff) database.a2aTasks.delete(row);
    return Promise.resolve();
  }
}

/** Takes no owner for any owner: one message id across callers. */
class SharesOwners extends InMemoryA2ATaskRepository {
  override saveIfAbsent(task: NewA2ATask): Promise<A2ATaskSave> {
    return super
      .saveIfAbsent({ ...task, ownerId: undefined })
      .then((save) =>
        save.status === A2ATaskSaveStatus.Saved
          ? { ...save, task: { ...save.task, ownerId: task.ownerId } }
          : save,
      );
  }
}

/** Counts the page it gives, not every task the query matches (#824). */
class CountsThePage extends InMemoryA2ATaskRepository {
  override async list(query: A2ATaskQuery): Promise<A2ATaskPage> {
    const page = await super.list(query);
    return { ...page, totalSize: page.tasks.length };
  }
}

/** Leaves the status time filter out (#824): every task, however old its status. */
class IgnoresStatusTime extends InMemoryA2ATaskRepository {
  override list(query: A2ATaskQuery): Promise<A2ATaskPage> {
    const { statusAtAfter: _ignored, ...rest } = query;
    return super.list(rest);
  }
}

/** Sweeps a finished task's messages only: a follow-up whose task is gone stays for ever (#960). */
class KeepsOrphans extends InMemoryA2ATaskRepository {
  constructor(private readonly rows: InMemoryDatabase) {
    super(rows);
  }

  override async deleteTerminalByStatusAtBefore(cutoff: Date): Promise<void> {
    const { a2aMessages: messages, a2aTasks: tasks } = this.rows;
    const orphans = [...messages].filter(([, message]) => !tasks.has(a2aTaskRowOf(message)));
    await super.deleteTerminalByStatusAtBefore(cutoff);
    for (const [row, message] of orphans) messages.set(row, message);
  }
}

/** Keeps the status keys it knows and drops the rest, as a schema that strips them does (#960). */
class DropsStatusKeys extends InMemoryA2ATaskRepository {
  override async findById(key: A2ATaskKey): Promise<A2ATaskRecord | undefined> {
    const task = await super.findById(key);
    return task === undefined ? undefined : { ...task, status: knownOf(task.status) };
  }
}

const knownOf = ({ futureField: _dropped, ...known }: A2ATaskStatus & { futureField?: unknown }) =>
  known;

a2aTaskContract(target("sound", InMemoryA2ATaskRepository));
a2aTaskContract(target("keeps orphan messages", KeepsOrphans));
a2aTaskContract(target("drops unknown status keys", DropsStatusKeys));
a2aTaskContract(target("counts the page", CountsThePage));
a2aTaskContract(target("ignores the status time", IgnoresStatusTime));
a2aTaskContract(target("checks then writes", CheckThenWrite));
a2aTaskContract(target("ignores the version", IgnoresVersion));
a2aTaskContract(target("overwrites a terminal status", OverwritesTerminal));
a2aTaskContract(target("lists unsorted", Unsorted));
a2aTaskContract(target("sweeps unfinished tasks", SweepsUnfinished));
a2aTaskContract(target("shares message ids across owners", SharesOwners));
