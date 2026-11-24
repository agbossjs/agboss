import { hours, usd } from "../../units/index.js";
import { expect } from "vitest";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "../../infrastructure/execution-record.repository.js";
import type { ThreadStatusTransition } from "../../turns/index.js";
import type { NewTurn, TurnOutcome } from "../../turns/index.js";
import type { ContractCase, ContractGroup } from "./define.js";
import { nulCaseName, NUL_TEXT } from "./nul-text.js";

/**
 * The status history of a thread (#1341d, `statusHistory`): every status change a record write
 * makes is one row, in the transaction of the write, numbered from 1 per `(tenant, thread)` and
 * chained from the status before; a write that leaves the status as it was adds none; one thread's
 * or tenant's rows are never another's; `forgetStatusHistory` and the idle sweep remove a thread's
 * rows. The lease marks' rows (`requestCancel`'s `transition`) are the lease contract's, and a store
 * set that shares one backend passes both in one transaction (`LeaseCheck.Atomic`'s sibling rule).
 */

const WORKFLOW = "desk-workflow";

const outcome = (status: ExecutionRecordStatus): TurnOutcome => ({
  replyWith: "",
  status,
  stopReason: "",
  route: [],
  steps: [],
  costUsd: usd(0),
});

const record = (threadId: string, tenantId = "default"): NewTurn => ({
  ...outcome(ExecutionRecordStatus.Running),
  runId: "run-1",
  threadId,
  tenantId,
  workflow: WORKFLOW,
  task: "where is order 7?",
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: "1.0.0",
  configHash: "hash",
});

/** What a history says, without the times. */
const shapeOf = (history: readonly ThreadStatusTransition[]) =>
  history.map(({ seq, fromStatus, toStatus, trigger }) => ({
    seq,
    fromStatus,
    toStatus,
    trigger,
  }));

const ended = (): Promise<boolean> => Promise.resolve(true);

const CASES: readonly ContractCase<ExecutionRecordRepository>[] = [
  {
    name: "#1341d: a run's record writes are its history — started, asked, resumed, finished — read by either instance",
    run: async ({ first, second }) => {
      const thread = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      const written = await first.append(record(thread));
      await first.complete(written.id, outcome(ExecutionRecordStatus.Paused));
      expect(
        await second.completeIfStatus(
          written.id,
          ExecutionRecordStatus.Paused,
          outcome(ExecutionRecordStatus.Running),
        ),
      ).toBe(true);
      await second.complete(written.id, outcome(ExecutionRecordStatus.Answered));

      expect(shapeOf(await second.statusHistory("default", thread))).toEqual([
        { seq: 1, fromStatus: null, toStatus: "running", trigger: "start" },
        { seq: 2, fromStatus: "running", toStatus: "paused", trigger: "ask" },
        { seq: 3, fromStatus: "paused", toStatus: "running", trigger: "resume" },
        { seq: 4, fromStatus: "running", toStatus: "finished", trigger: "finish" },
      ]);
    },
  },
  {
    name: "#1341d: a refused compare-and-set writes no row, and a write that keeps the status adds none",
    run: async ({ first }) => {
      const thread = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      const written = await first.append(record(thread));

      expect(
        await first.completeIfStatus(
          written.id,
          ExecutionRecordStatus.Paused,
          outcome(ExecutionRecordStatus.Answered),
        ),
      ).toBe(false);
      await first.complete(written.id, outcome(ExecutionRecordStatus.Running));

      expect(shapeOf(await first.statusHistory("default", thread))).toEqual([
        { seq: 1, fromStatus: null, toStatus: "running", trigger: "start" },
      ]);
    },
  },
  {
    name: "#1341d: a command's context — its trigger, reason, actor and lease token — is kept as given",
    run: async ({ first }) => {
      const thread = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      const written = await first.append(record(thread));
      await first.complete(written.id, outcome(ExecutionRecordStatus.Cancelled), {
        reason: "customer withdrew",
        actor: "ops-1",
        leaseToken: 3,
      });

      const [, last] = await first.statusHistory("default", thread);

      expect(last).toMatchObject({
        toStatus: "cancelled",
        trigger: "cancel",
        reason: "customer withdrew",
        actor: "ops-1",
        leaseToken: 3,
      });
      expect(last?.at).toBeInstanceOf(Date);
    },
  },
  {
    name: nulCaseName("#1341d: a reason"),
    run: async ({ first }) => {
      const thread = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      const written = await first.append(record(thread));
      await first.complete(written.id, outcome(ExecutionRecordStatus.Stopped), {
        reason: NUL_TEXT,
        actor: NUL_TEXT,
      });

      const [, last] = await first.statusHistory("default", thread);

      expect(last).toMatchObject({ reason: NUL_TEXT, actor: NUL_TEXT });
    },
  },
  {
    name: "#1341d: the history of a thread is its tenant's and its own — the same id in two tenants, and another thread, never mix",
    run: async ({ first, second }) => {
      const mine = await first.createThread({
        workflow: WORKFLOW,
        tenantId: "default",
        threadId: "shared-id",
      });
      const theirs = await first.createThread({
        workflow: WORKFLOW,
        tenantId: "acme",
        threadId: "shared-id",
      });
      const other = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      await first.append(record(mine));
      await first.append(record(other));
      expect(await second.statusHistory("acme", theirs)).toEqual([]);

      await first.append(record(theirs, "acme"));

      expect(await second.statusHistory("default", mine)).toHaveLength(1);
      expect(await second.statusHistory("acme", theirs)).toHaveLength(1);
      expect(await second.statusHistory("default", "no-such-thread")).toEqual([]);
    },
  },
  {
    name: "#1341d: forgetStatusHistory removes one thread's rows and no other's, and a thread with none is a no-op",
    run: async ({ first, second }) => {
      const gone = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      const kept = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      await first.append(record(gone));
      await first.append(record(kept));

      await second.forgetStatusHistory("default", gone);
      await second.forgetStatusHistory("default", "never-existed");

      expect(await first.statusHistory("default", gone)).toEqual([]);
      expect(await first.statusHistory("default", kept)).toHaveLength(1);
    },
  },
  {
    name: "#1341d: the idle sweep removes a swept thread's history with it — no row outlives its thread",
    run: async ({ clock, first, second }) => {
      const thread = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      const written = await first.append(record(thread));
      await first.complete(written.id, outcome(ExecutionRecordStatus.Answered));
      await clock.advance(hours(2));

      const removed = await second.deleteIdleThreads(
        new Map([[WORKFLOW, new Date(clock.now().getTime() - hours(1))]]),
        ended,
      );

      expect(removed).toBe(1);
      expect(await first.statusHistory("default", thread)).toEqual([]);
    },
  },
];

export const executionRecordStatusHistoryCases = (): ContractGroup<ExecutionRecordRepository> => ({
  title: "the status history of a thread",
  cases: CASES,
});
