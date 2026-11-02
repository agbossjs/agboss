import { expect } from "vitest";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "../../infrastructure/execution-record.repository.js";
import type { NewTern, TernOutcome } from "../../terns/index.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import { nulCaseName, NUL_TEXT } from "./nul-text.js";
import { PAUSE_ANSWER_CASES } from "./pause-answer-log.cases.js";
import type { ContractTarget } from "./seam.js";

/** An outcome with `status`. */
const outcome = (status: ExecutionRecordStatus): TernOutcome => ({
  replyWith: status === ExecutionRecordStatus.Answered ? "Done." : "",
  status,
  stopReason: "",
  route: ["start", "clerk"],
  steps: [],
  costUsd: 0.01,
});

/** A new record of `threadId` with `status`. */
const record = (threadId: string, runId: string, status: ExecutionRecordStatus): NewTern => ({
  ...outcome(status),
  runId,
  threadId,
  tenantId: "default",
  bundle: "desk-workflow",
  task: "where is order 7?",
  promptVersion: "p1",
  modelVersion: "m1",
  replayOf: null,
  configVersion: "1.0.0",
  configHash: "hash",
});

/** A thread of the desk's workflow, made on `records`, with a record of it paused. */
async function pausedRecordOn(records: ExecutionRecordRepository): Promise<string> {
  const thread = await records.createThread({ workflow: "desk-workflow", tenantId: "default" });
  return (await records.append(record(thread, "run-1", ExecutionRecordStatus.Paused))).id;
}

const RECORD_CASES: readonly ContractCase<ExecutionRecordRepository>[] = [
  {
    name: "a thread made on one instance is known to the other, with its owner",
    run: async ({ first, second }) => {
      const thread = await first.createThread({
        workflow: "desk-workflow",
        tenantId: "default",
        ownerId: "dana",
      });

      expect(await second.hasThread("desk-workflow", "default", thread)).toBe(true);
      expect(await second.threadOwner("desk-workflow", "default", thread)).toEqual({
        owner: "dana",
      });
      expect(await second.hasThread("other-workflow", "default", thread)).toBe(false);
    },
  },
  {
    name: "the running roots are listed page by page, oldest first",
    run: async ({ first, second }) => {
      const thread = await first.createThread({ workflow: "desk-workflow", tenantId: "default" });
      const ids: string[] = [];
      for (const runId of ["run-1", "run-2", "run-3"]) {
        ids.push((await first.append(record(thread, runId, ExecutionRecordStatus.Running))).id);
      }
      await first.append(record(thread, "run-4", ExecutionRecordStatus.Answered));

      const page = await second.findByStatus(ExecutionRecordStatus.Running, 2);
      const next = await second.findByStatus(ExecutionRecordStatus.Running, 2, page.at(-1)?.id);

      expect(page.map((item) => item.runId)).toEqual(["run-1", "run-2"]);
      expect(next.map((item) => item.runId)).toEqual(["run-3"]);
      expect((await second.byIds(ids)).map((item) => item.status)).toEqual([
        "running",
        "running",
        "running",
      ]);
    },
  },
  {
    name: "compare-and-set: the write lands only from the expected status (S66 h)",
    run: async ({ first, second }) => {
      const id = await pausedRecordOn(first);

      // the holder finished the tree; the resume's `running` write arrives after it
      await first.complete(id, outcome(ExecutionRecordStatus.Answered));
      const late = await second.completeIfStatus(
        id,
        ExecutionRecordStatus.Paused,
        outcome(ExecutionRecordStatus.Running),
      );

      expect(late).toBe(false);
      expect((await first.byIds([id]))[0]?.status).toBe(ExecutionRecordStatus.Answered);
    },
  },
  {
    name: nulCaseName("a record's task and answer"),
    run: async ({ first, second }) => {
      const thread = await first.createThread({ workflow: "desk-workflow", tenantId: "default" });
      const appended = await first.append({
        ...record(thread, "run-1", ExecutionRecordStatus.Running),
        task: NUL_TEXT,
      });

      await first.complete(appended.id, {
        ...outcome(ExecutionRecordStatus.Answered),
        replyWith: NUL_TEXT,
      });

      expect((await second.byIds([appended.id]))[0]).toMatchObject({
        task: NUL_TEXT,
        replyWith: NUL_TEXT,
      });
    },
  },
  {
    name: nulCaseName("a summary's text"),
    run: async ({ first, second }) => {
      const thread = await first.createThread({ workflow: "desk-workflow", tenantId: "default" });
      const turn = await first.append(record(thread, "run-1", ExecutionRecordStatus.Answered));

      await first.addSummary({
        tenantId: "default",
        threadId: thread,
        bundle: "desk-workflow",
        compaction: "conversation-compaction",
        fromTernId: turn.id,
        toTernId: turn.id,
        turns: 1,
        text: NUL_TEXT,
        costUsd: 0,
      });

      const [summary] = await second.latestSummaries(
        "default",
        thread,
        "conversation-compaction",
        1,
      );
      expect(summary?.text).toBe(NUL_TEXT);
    },
  },
  {
    name: "compare-and-set: of two writes from one status exactly one lands",
    run: async ({ first, second }) => {
      const id = await pausedRecordOn(first);
      const from = ExecutionRecordStatus.Paused;

      const landed = await Promise.all([
        first.completeIfStatus(id, from, outcome(ExecutionRecordStatus.Running)),
        second.completeIfStatus(id, from, outcome(ExecutionRecordStatus.Failed)),
      ]);

      expect(landed.filter(Boolean)).toHaveLength(1);
      expect((await second.byIds([id]))[0]?.status).toBe(ExecutionRecordStatus.Running);
    },
  },
];

/**
 * `ExecutionRecordRepository` (#265 AC7): threads and their owners, one record per execution,
 * recovery's paged look-up of `running` roots, and the compare-and-set write (S66 h): a status
 * write lands only while the record still has the expected status; the pause answer log, one
 * answer per pause of a tree (#676).
 */
export function executionRecordContract(target: ContractTarget<ExecutionRecordRepository>): void {
  registerContract(
    "execution record contract",
    target,
    [{ cases: RECORD_CASES }, { cases: PAUSE_ANSWER_CASES }],
    pingOf,
  );
}
