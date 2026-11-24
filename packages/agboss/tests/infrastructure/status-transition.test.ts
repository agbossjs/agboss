/**
 * #1341d — the status history of a thread: one row per change of its status, written in the
 * transaction of the change (a lease's cancel mark, a record's status write), on the in-memory
 * stores and on SQLite; a repeated command and a write that changes nothing add none.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record-status.js";
import {
  memoryStatusLog,
  sqliteStatusLog,
  StatusTrigger,
  ThreadStatus,
  type NewStatusTransition,
  type ThreadStatusTransition,
} from "../../src/turns/index.js";
import { ApplicationContext } from "../../src/flow/context/application-context.js";
import { RandomIdGenerator, StoreClock } from "../../src/infrastructure/clock.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteExecutionRecordRepository } from "../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import { VirtualClock } from "../../src/testing/index.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

const NEXT: NewStatusTransition = {
  tenantId: "t1",
  threadId: "th1",
  toStatus: ThreadStatus.Running,
  trigger: StatusTrigger.Start,
};
const AT = new Date("2026-11-24T10:00:00.000Z");

const rowsOf = (history: readonly ThreadStatusTransition[]) =>
  history.map(({ seq, fromStatus, toStatus, trigger }) => ({ seq, fromStatus, toStatus, trigger }));

/** The same cases on the two kinds of log. */
const logs = {
  memory: () => memoryStatusLog(new Map()),
  sqlite: () => {
    const connection = connectionTo(temporarySqlitePath());
    return sqliteStatusLog(connection.database);
  },
};

for (const [kind, make] of Object.entries(logs)) {
  describe(`#1341d: the status log (${kind})`, () => {
    it("numbers a thread's rows from 1 and chains each from the status before", () => {
      const log = make();
      log.appended(NEXT, AT);
      log.appended(
        { ...NEXT, toStatus: ThreadStatus.Cancelling, trigger: StatusTrigger.Cancel },
        AT,
      );
      log.appended(
        { ...NEXT, toStatus: ThreadStatus.Cancelled, trigger: StatusTrigger.Cancel },
        AT,
      );

      expect(rowsOf(log.historyOf(NEXT))).toEqual([
        { seq: 1, fromStatus: null, toStatus: "running", trigger: "start" },
        { seq: 2, fromStatus: "running", toStatus: "cancelling", trigger: "cancel" },
        { seq: 3, fromStatus: "cancelling", toStatus: "cancelled", trigger: "cancel" },
      ]);
    });

    it("writes nothing for a change to the status the thread already has", () => {
      const log = make();
      log.appended(NEXT, AT);

      expect(log.appended({ ...NEXT, trigger: StatusTrigger.Resume }, AT)).toBeUndefined();
      expect(log.historyOf(NEXT)).toHaveLength(1);
    });

    it("keeps the operator's reason (a NUL too), the actor and the lease token; time as given", () => {
      const log = make();
      log.appended({ ...NEXT, reason: "wait\u0000 now", actor: "ops-1", leaseToken: 4 }, AT);

      expect(log.historyOf(NEXT)).toEqual([
        expect.objectContaining({
          reason: "wait\u0000 now",
          actor: "ops-1",
          leaseToken: 4,
          at: AT,
        }),
      ]);
    });

    it("keeps threads and tenants apart, and forgets one thread's rows only", () => {
      const log = make();
      log.appended(NEXT, AT);
      log.appended({ ...NEXT, threadId: "th2" }, AT);
      log.appended({ ...NEXT, tenantId: "t2" }, AT);

      log.forgotten(NEXT);

      expect(log.historyOf(NEXT)).toEqual([]);
      expect(log.historyOf({ ...NEXT, threadId: "th2" })).toHaveLength(1);
      expect(log.historyOf({ ...NEXT, tenantId: "t2" })).toHaveLength(1);
    });
  });
}

const THREAD = { tenantId: "default", threadId: "thread-1" };
const turn = (status: "running" | "paused") => ({
  runId: "run-1",
  threadId: THREAD.threadId,
  tenantId: THREAD.tenantId,
  workflow: "wf",
  task: "t",
  replyWith: "",
  status,
  stopReason: "",
  route: [],
  steps: [],
  costUsd: 0 as never,
  promptVersion: "p",
  modelVersion: "m",
  replayOf: null,
  configVersion: null,
  configHash: null,
});

describe("#1341d: the in-memory stores share one history", () => {
  const stores = () => {
    const database = new InMemoryDatabase();
    const clock = new VirtualClock();
    const records = new InMemoryExecutionRecordRepository(clock, new RandomIdGenerator(), database);
    const leases = new InMemoryExecutionLeaseRepository(
      clock as never,
      { instanceId: "i1" } as ApplicationContext,
      database,
    );
    return { records, leases };
  };

  it("a record's statuses and a lease's cancel mark make one chain", async () => {
    const { records, leases } = stores();
    await records.createThread({
      workflow: "wf",
      tenantId: THREAD.tenantId,
      threadId: THREAD.threadId,
    });
    const written = await records.append(turn("running"));
    await leases.requestCancel(
      { tenantId: THREAD.tenantId, rootExecutionId: "run-1" },
      { ...THREAD, toStatus: ThreadStatus.Cancelling, trigger: StatusTrigger.Cancel, actor: "ops" },
    );
    await records.complete(written.id, {
      replyWith: "",
      status: ExecutionRecordStatus.Cancelled,
      stopReason: "",
      route: [],
      steps: [],
      costUsd: 0 as never,
    });

    const history = await records.statusHistory(THREAD.tenantId, THREAD.threadId);

    expect(rowsOf(history)).toEqual([
      { seq: 1, fromStatus: null, toStatus: "running", trigger: "start" },
      { seq: 2, fromStatus: "running", toStatus: "cancelling", trigger: "cancel" },
      { seq: 3, fromStatus: "cancelling", toStatus: "cancelled", trigger: "cancel" },
    ]);
    expect(history[1]?.actor).toBe("ops");
  });

  it("a repeated cancel adds no row, and a cancel with no transition adds none either", async () => {
    const { records, leases } = stores();
    const tree = { tenantId: THREAD.tenantId, rootExecutionId: "run-1" };
    const cancelling = {
      ...THREAD,
      toStatus: ThreadStatus.Cancelling,
      trigger: StatusTrigger.Cancel,
    };

    await leases.requestCancel(tree, cancelling);
    await leases.requestCancel(tree, { ...cancelling, reason: "again" });
    await leases.requestCancel({ ...tree, rootExecutionId: "run-2" });

    expect(await records.statusHistory(THREAD.tenantId, THREAD.threadId)).toHaveLength(1);
  });

  it("forgetStatusHistory removes the thread's rows", async () => {
    const { records, leases } = stores();
    await leases.requestCancel(
      { tenantId: THREAD.tenantId, rootExecutionId: "run-1" },
      { ...THREAD, toStatus: ThreadStatus.Cancelling, trigger: StatusTrigger.Cancel },
    );

    await records.forgetStatusHistory(THREAD.tenantId, THREAD.threadId);

    expect(await records.statusHistory(THREAD.tenantId, THREAD.threadId)).toEqual([]);
  });
});

describe("#1341d: SQLite writes the mark and its row in one transaction", () => {
  const stores = () => {
    const path = temporarySqlitePath();
    const connection = connectionTo(path);
    const clock = new VirtualClock();
    const context = { instanceId: "i1" } as ApplicationContext;
    const leases = new SqliteExecutionLeaseRepository(
      connection,
      clock as never,
      context,
    );
    const records = new SqliteExecutionRecordRepository(
      connection,
      clock,
      context,
      new RandomIdGenerator(),
    );
    return { connection, leases, records };
  };

  it("a cancel's row exists exactly when its mark does", async () => {
    const { leases, records } = stores();
    const tree = { tenantId: THREAD.tenantId, rootExecutionId: "run-1" };
    await records.createThread({
      workflow: "wf",
      tenantId: THREAD.tenantId,
      threadId: THREAD.threadId,
    });

    await leases.requestCancel(tree, {
      ...THREAD,
      toStatus: ThreadStatus.Cancelling,
      trigger: StatusTrigger.Cancel,
      reason: "customer withdrew",
    });
    await leases.requestCancel(tree, {
      ...THREAD,
      toStatus: ThreadStatus.Cancelling,
      trigger: StatusTrigger.Cancel,
    });

    expect(await leases.isCancelRequested(tree)).toBe(true);
    const history = await records.statusHistory(THREAD.tenantId, THREAD.threadId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ toStatus: "cancelling", reason: "customer withdrew" });
  });

  it("a mark whose transaction rolls back leaves no row", async () => {
    const { connection, records } = stores();
    expect(() => {
      connection.transaction(() => {
        sqliteStatusLog(connection.database).appended(
          { ...THREAD, toStatus: ThreadStatus.Running, trigger: StatusTrigger.Start },
          AT,
        );
        throw new Error("crash between the mark and the commit");
      });
    }).toThrow("crash");

    expect(await records.statusHistory(THREAD.tenantId, THREAD.threadId)).toEqual([]);
  });

  it("a record's status write and its row are one transaction", async () => {
    const { records } = stores();
    await records.createThread({
      workflow: "wf",
      tenantId: THREAD.tenantId,
      threadId: THREAD.threadId,
    });
    const written = await records.append(turn("running"), { actor: "ops" });
    const isDone = await records.completeIfStatus(
      written.id,
      ExecutionRecordStatus.Running,
      {
        replyWith: "",
        status: ExecutionRecordStatus.Paused,
        stopReason: "",
        route: [],
        steps: [],
        costUsd: 0 as never,
      },
      { reason: "asked" },
    );
    const refused = await records.completeIfStatus(written.id, ExecutionRecordStatus.Running, {
      replyWith: "",
      status: ExecutionRecordStatus.Answered,
      stopReason: "",
      route: [],
      steps: [],
      costUsd: 0 as never,
    });

    expect(isDone).toBe(true);
    expect(refused).toBe(false);
    expect(rowsOf(await records.statusHistory(THREAD.tenantId, THREAD.threadId))).toEqual([
      { seq: 1, fromStatus: null, toStatus: "running", trigger: "start" },
      { seq: 2, fromStatus: "running", toStatus: "paused", trigger: "ask" },
    ]);
  });
});
