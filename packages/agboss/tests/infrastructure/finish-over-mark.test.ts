/**
 * agbossjs/agboss#1341b (money review 2026-11-25, finding 5): "a finish never lands over a durable
 * stop or cancel mark" was a look, then a write. A remote `app.cancel` that marks the tree between
 * the two answered `cancelled: true` while the record was written `answered`. The finish is now
 * `completeUnlessInterrupted`: it reads the tree's marks on its lease row in the write's own
 * transaction and refuses over one — on the in-memory stores (one synchronous step over the shared
 * database) and on a SQLite file (two connections, each a `BEGIN IMMEDIATE`). A cancel or stop after
 * the finish is written leaves the finish, and the thread's next execution is not affected.
 */
import { describe, expect, it } from "vitest";
import { cancelTransitionOf } from "../../src/app/cancel-marks.js";
import { InterruptMode } from "../../src/app/interrupt-types.js";
import { stopTransitionOf } from "../../src/app/stop-requests.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { randomIdGenerator } from "../../src/infrastructure/clock.js";
import {
  InMemoryExecutionLeaseRepository,
  type ExecutionLeaseRepository,
} from "../../src/infrastructure/execution-lease.repository.js";
import {
  ExecutionRecordStatus,
  InMemoryExecutionRecordRepository,
  type ExecutionRecordRepository,
} from "../../src/infrastructure/execution-record.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteExecutionRecordRepository } from "../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import type { TurnOutcome } from "../../src/turns/index.js";
import { usd } from "../../src/units/index.js";
import { storeClockOf } from "../helpers/store-clock.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";

interface Instance {
  readonly leases: ExecutionLeaseRepository;
  readonly records: ExecutionRecordRepository;
}

const contextOf = (instanceId: string) =>
  applicationContextOf({
    name: "finish-mark-application",
    version: "1.0.0",
    instanceId,
    startedAt: new Date(0),
    profiles: ["test"],
  });

/** The holder and the operator's instance over one in-memory database. */
function inMemoryPair(): readonly [Instance, Instance] {
  const database = new InMemoryDatabase();
  const clock = new VirtualClock();
  const records = new InMemoryExecutionRecordRepository(clock, randomIdGenerator, database);
  const on = (instanceId: string): Instance => ({
    leases: new InMemoryExecutionLeaseRepository(
      storeClockOf(clock),
      contextOf(instanceId),
      database,
    ),
    records,
  });
  return [on("instance-1"), on("instance-2")];
}

/** The holder and the operator's instance, each on its own connection to one SQLite file. */
function sqlitePair(): readonly [Instance, Instance] {
  const path = temporarySqlitePath();
  const on = (instanceId: string): Instance => {
    const connection = connectionTo(path);
    const clock = new VirtualClock();
    const context = contextOf(instanceId);
    return {
      leases: new SqliteExecutionLeaseRepository(connection, storeClockOf(clock), context),
      records: new SqliteExecutionRecordRepository(connection, clock, context, randomIdGenerator),
    };
  };
  return [on("instance-1"), on("instance-2")];
}

const outcome = (status: ExecutionRecordStatus): TurnOutcome => ({
  replyWith: status === ExecutionRecordStatus.Answered ? "finish receipt: {}" : "",
  status,
  stopReason: "",
  route: [],
  steps: [],
  costUsd: usd(0),
});

/** A root running on thread `threadId`, its record `running`. */
async function runningOn(holder: Instance) {
  const threadId = await holder.records.createThread({
    workflow: "desk-workflow",
    tenantId: "default",
  });
  const record = await holder.records.append({
    ...outcome(ExecutionRecordStatus.Running),
    runId: "root-1",
    threadId,
    tenantId: "default",
    workflow: "desk-workflow",
    task: "start x: {}",
    promptVersion: "p1",
    modelVersion: "m1",
    replayOf: null,
    configVersion: "1.0.0",
    configHash: "hash",
  });
  const thread = { tenantId: "default", threadId };
  return { thread, record, tree: { tenantId: "default", rootExecutionId: "root-1" } };
}

describe.each([
  ["in-memory", inMemoryPair],
  ["SQLite (two connections to one file)", sqlitePair],
] as const)(
  "agbossjs/agboss#1341b: a finish never lands over a stop or cancel mark — %s",
  (_, pair) => {
    it("a cancel from the other instance between the finish's look and its write: the write is refused, nothing written — the record stays running for its cancelled end", async () => {
      const [holder, operator] = pair();
      const { thread, record, tree } = await runningOn(holder);
      // the finish looked: no mark. The other instance's cancel lands now, before the write
      expect((await holder.leases.markedOf(tree)).isCancelRequested).toBe(false);
      await operator.leases.requestCancel(tree, cancelTransitionOf(thread, { ownerId: null }));

      const isWritten = await holder.records.completeUnlessInterrupted(
        record.id,
        outcome(ExecutionRecordStatus.Answered),
      );
      // what the cancel's settlement reads: still running, its holder's to end — as `cancelled`
      const [read] = await operator.records.byIds([record.id]);
      await holder.records.complete(record.id, outcome(ExecutionRecordStatus.Cancelled));

      expect(isWritten).toBe(false);
      expect(read?.status).toBe("running");
      expect((await operator.records.byIds([record.id]))[0]?.status).toBe("cancelled");
      expect(
        (await operator.records.statusHistory("default", thread.threadId)).map(
          ({ toStatus }) => toStatus,
        ),
      ).toEqual(["running", "cancelling", "cancelled"]);
    });

    it("a stop (either mode) between the look and the write refuses it too", async () => {
      for (const mode of [InterruptMode.AfterStep, InterruptMode.Immediate]) {
        const [holder, operator] = pair();
        const { thread, record, tree } = await runningOn(holder);
        await operator.leases.requestStop(tree, mode, stopTransitionOf(thread, { ownerId: null }));

        expect(
          await holder.records.completeUnlessInterrupted(
            record.id,
            outcome(ExecutionRecordStatus.Answered),
          ),
        ).toBe(false);
        expect((await operator.records.byIds([record.id]))[0]?.status).toBe("running");
      }
    });

    it("a cancel after the finish was written finds it answered: the finish stays, its history ends finished", async () => {
      const [holder, operator] = pair();
      const { thread, record, tree } = await runningOn(holder);

      const isWritten = await holder.records.completeUnlessInterrupted(
        record.id,
        outcome(ExecutionRecordStatus.Answered),
      );
      await operator.leases.requestCancel(tree, cancelTransitionOf(thread, { ownerId: null }));

      expect(isWritten).toBe(true);
      expect((await operator.records.byIds([record.id]))[0]?.status).toBe("answered");
      expect(
        (await operator.records.statusHistory("default", thread.threadId)).map(
          ({ toStatus }) => toStatus,
        ),
      ).toEqual(["running", "finished", "cancelling"]);
      // the mark is the tree's, not the thread's: the thread's next execution finishes
      const next = await holder.records.append({
        ...outcome(ExecutionRecordStatus.Running),
        runId: "root-2",
        threadId: thread.threadId,
        tenantId: "default",
        workflow: "desk-workflow",
        task: "start x: {}",
        promptVersion: "p1",
        modelVersion: "m1",
        replayOf: null,
        configVersion: "1.0.0",
        configHash: "hash",
      });
      expect(
        await holder.records.completeUnlessInterrupted(
          next.id,
          outcome(ExecutionRecordStatus.Answered),
        ),
      ).toBe(true);
    });
  },
);
