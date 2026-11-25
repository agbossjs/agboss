import { hours, usd } from "../../units/index.js";
import { expect } from "vitest";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "../../infrastructure/execution-record.repository.js";
import type { NewTurn } from "../../turns/index.js";
import type { ContractCase, ContractGroup } from "./define.js";
import { answerOf } from "./pause-answer-log.cases.js";

/**
 * The sweep of idle threads (#1303c, `@Memory({ ttl })`): `deleteIdleThreads(cutoffs, isEnded)`
 * removes the threads of a workflow last active before its cutoff, with their records, summaries,
 * owners and pause answers, and counts them — never a thread of a live or paused tree, whatever its
 * age. A thread's activity is a record written or completed, not the thread's creation.
 */

const WORKFLOW = "desk-workflow";

const record = (threadId: string, runId: string, status: ExecutionRecordStatus): NewTurn => ({
  replyWith: status === ExecutionRecordStatus.Answered ? "Done." : "",
  status,
  stopReason: "",
  route: ["start", "clerk"],
  steps: [],
  costUsd: usd(0.01),
  runId,
  threadId,
  tenantId: "default",
  workflow: WORKFLOW,
  task: "where is order 7?",
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: "1.0.0",
  configHash: "hash",
});

const ended = (): Promise<boolean> => Promise.resolve(true);

/** The cutoff an hour before `now`, for the workflow of these cases. */
const hourAgo = (now: Date, workflow = WORKFLOW): ReadonlyMap<string, Date> =>
  new Map([[workflow, new Date(now.getTime() - hours(1))]]);

const CASES: readonly ContractCase<ExecutionRecordRepository>[] = [
  {
    name: "an idle, ended thread is swept after its ttl, with its records, summaries, owner and pause answers (1303c)",
    run: async ({ clock, first, second }) => {
      const thread = await first.createThread({
        workflow: WORKFLOW,
        tenantId: "default",
        ownerId: "dana",
      });
      const turn = await first.append(record(thread, "run-1", ExecutionRecordStatus.Answered));
      await first.addSummary({
        tenantId: "default",
        threadId: thread,
        workflow: WORKFLOW,
        memory: "desk-memory",
        fromTurnId: turn.id,
        toTurnId: turn.id,
        turns: 1,
        text: "a summary",
        costUsd: usd(0.01),
      });
      await first.savePauseAnswer("default", "run-1", answerOf("dana", true));
      await clock.advance(hours(2));

      const removed = await second.deleteIdleThreads(hourAgo(clock.now()), ended);

      expect(removed).toBe(1);
      // an owned thread stays as a tombstone: its owner is kept, nothing else of it
      expect(await first.threadOwner(WORKFLOW, "default", thread)).toMatchObject({ owner: "dana" });
      expect(await first.lastTurns("default", thread, 10)).toEqual([]);
      expect(await first.summaryCount("default", thread, "desk-memory")).toBe(0);
      expect(await first.findPauseAnswersByTenantIdAndRootExecutionId("default", "run-1")).toEqual(
        [],
      );
      expect(await second.deleteIdleThreads(hourAgo(clock.now()), ended)).toBe(0);
    },
  },
  {
    name: "a swept thread leaves nothing another owner can claim: the id stays its owner's, and the same owner restarts clean (1303c)",
    run: async ({ clock, first, second }) => {
      const thread = await first.createThread({
        workflow: WORKFLOW,
        tenantId: "default",
        ownerId: "dana",
        threadId: "case-7",
      });
      await first.append(record(thread, "run-1", ExecutionRecordStatus.Answered));
      await clock.advance(hours(2));
      await second.deleteIdleThreads(hourAgo(clock.now()), ended);

      for (const ownerId of ["mallory", undefined])
        await expect(
          second.createThread({
            workflow: WORKFLOW,
            tenantId: "default",
            ...(ownerId === undefined ? {} : { ownerId }),
            threadId: "case-7",
          }),
        ).rejects.toThrow();
      await expect(
        second.append(record("case-7", "run-x", ExecutionRecordStatus.Answered)),
      ).rejects.toThrow();

      expect(await first.threadOwner(WORKFLOW, "default", "case-7")).toMatchObject({
        owner: "dana",
      });
      expect(await first.lastTurns("default", "case-7", 10)).toEqual([]);
      await second.createThread({
        workflow: WORKFLOW,
        tenantId: "default",
        ownerId: "dana",
        threadId: "case-7",
      });
      expect(await first.lastTurns("default", "case-7", 10)).toEqual([]);
      await first.append(record("case-7", "run-2", ExecutionRecordStatus.Answered));
      expect(await first.lastTurns("default", "case-7", 10)).toHaveLength(1);
    },
  },
  {
    name: "a Ttl sweep keeps a live thread's turns: a running, a paused or a not yet ended tree, whatever its age (1303c)",
    run: async ({ clock, first, second }) => {
      const running = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      await first.append(record(running, "run-r", ExecutionRecordStatus.Running));
      const paused = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      await first.append(record(paused, "run-p", ExecutionRecordStatus.Paused));
      const open = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      await first.append(record(open, "run-o", ExecutionRecordStatus.Answered));
      await clock.advance(hours(48));
      const asked: string[] = [];

      const removed = await second.deleteIdleThreads(
        hourAgo(clock.now()),
        ({ rootExecutionId }) => {
          asked.push(rootExecutionId);
          return Promise.resolve(false);
        },
      );

      expect(removed).toBe(0);
      expect(asked).toContain("run-o");
      for (const thread of [running, paused, open]) {
        expect(await first.hasThread(WORKFLOW, "default", thread)).toBe(true);
        expect(await first.lastTurns("default", thread, 10)).toHaveLength(1);
      }
      // even when the caller says every tree ended: a running or paused record keeps its thread
      expect(await second.deleteIdleThreads(hourAgo(clock.now()), ended)).toBe(1);
      expect(await first.hasThread(WORKFLOW, "default", running)).toBe(true);
      expect(await first.hasThread(WORKFLOW, "default", paused)).toBe(true);
      expect(await first.hasThread(WORKFLOW, "default", open)).toBe(false);
    },
  },
  {
    name: "the ttl counts from a thread's last activity: a record written or completed since keeps it (1303c)",
    run: async ({ clock, first, second }) => {
      const written = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      await first.append(record(written, "run-1", ExecutionRecordStatus.Answered));
      const completed = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      const slow = await first.append(record(completed, "run-2", ExecutionRecordStatus.Paused));
      const quiet = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      await first.append(record(quiet, "run-3", ExecutionRecordStatus.Answered));
      await clock.advance(hours(2));
      await first.append(record(written, "run-4", ExecutionRecordStatus.Answered));
      await first.complete(slow.id, {
        replyWith: "Done.",
        status: ExecutionRecordStatus.Answered,
        stopReason: "",
        route: [],
        steps: [],
        costUsd: usd(0.02),
      });

      const removed = await second.deleteIdleThreads(hourAgo(clock.now()), ended);

      expect(removed).toBe(1);
      expect(await first.hasThread(WORKFLOW, "default", written)).toBe(true);
      expect(await first.hasThread(WORKFLOW, "default", completed)).toBe(true);
      expect(await first.hasThread(WORKFLOW, "default", quiet)).toBe(false);
    },
  },
  {
    name: "each workflow has its own cutoff; a workflow with none, and another tenant's thread of the same workflow, are not mixed up (1303c)",
    run: async ({ clock, first, second }) => {
      const desk = await first.createThread({ workflow: WORKFLOW, tenantId: "default" });
      await first.append(record(desk, "run-1", ExecutionRecordStatus.Answered));
      const other = await first.createThread({ workflow: "other-workflow", tenantId: "default" });
      await first.append({
        ...record(other, "run-2", ExecutionRecordStatus.Answered),
        workflow: "other-workflow",
      });
      const tenant = await first.createThread({ workflow: WORKFLOW, tenantId: "acme" });
      await first.append({
        ...record(tenant, "run-1", ExecutionRecordStatus.Answered),
        tenantId: "acme",
      });
      await clock.advance(hours(2));

      expect(await second.deleteIdleThreads(new Map(), ended)).toBe(0);
      const removed = await second.deleteIdleThreads(hourAgo(clock.now()), ended);

      expect(removed).toBe(2);
      expect(await first.hasThread(WORKFLOW, "default", desk)).toBe(false);
      expect(await first.hasThread(WORKFLOW, "acme", tenant)).toBe(false);
      expect(await first.hasThread("other-workflow", "default", other)).toBe(true);
    },
  },
];

export const executionRecordIdleSweepCases = (): ContractGroup<ExecutionRecordRepository> => ({
  title: "the sweep of idle threads",
  cases: CASES,
});
