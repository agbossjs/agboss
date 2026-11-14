import { expect } from "vitest";
import {
  PauseStatus,
  type PausedExecutionRepository,
} from "../../infrastructure/paused-execution.repository.js";
import { NO_RECIPIENTS } from "../../infrastructure/pause-notices.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import { nulCaseName, NUL_TEXT } from "./nul-text.js";
import { DECIDED_ANSWER, NINE, pausedRunOf, pauseOf } from "./paused-execution-data.js";
import { QUESTION_PAUSE_CASES } from "./paused-execution-question.cases.js";
import { PAUSE_RECORD_CASES } from "./paused-execution-record.cases.js";
import { PAUSE_TRANSITION_CASES } from "./paused-execution-resolution.cases.js";
import { CLOSER_RACE_CASES } from "./paused-execution-closers.cases.js";
import { DEADLINE_CASES } from "./paused-execution-deadline.cases.js";
import { DELIVERY_CASES } from "./paused-execution-delivery.cases.js";
import { EXTEND_CASES } from "./paused-execution-extend.cases.js";
import { NOTICE_ORDER_CASES } from "./paused-execution-order.cases.js";
import { RETENTION_CASES } from "./paused-execution-retention.cases.js";
import { SCAN_CASES } from "./paused-execution-scan.cases.js";
import { KEYSET_CASES } from "./paused-execution-keyset.cases.js";
import { TRANSITION_CASES } from "./paused-execution-transitions.cases.js";
import { CURSOR_CASES } from "./paused-execution-cursor.cases.js";
import { LATE_CLOSE_CASES } from "./paused-execution-late-close.cases.js";
import { NOTICE_WRITE_CASES } from "./paused-execution-notice.cases.js";
import type { ContractTarget } from "./instance-context.js";

const BY_THREAD_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a saved pause is found on the other instance as written, its versions with it",
    run: async ({ first, second }) => {
      const paused = pausedRunOf("thread-1");

      await first.save(paused);

      expect(await second.findByTenantIdAndThreadId("default", "thread-1")).toEqual(paused);
      expect(await second.findByTenantIdAndThreadId("default", "thread-2")).toBeUndefined();
    },
  },
  {
    name: "a later pause of the thread replaces the earlier one; a delete forgets it",
    run: async ({ first, second }) => {
      await first.save(pausedRunOf("thread-1", "run-1"));
      await first.save(pausedRunOf("thread-1", "run-2"));

      const latest = await second.findByTenantIdAndThreadId("default", "thread-1");
      await second.deleteByTenantIdAndThreadId("default", "thread-1");

      expect(latest?.run.runId).toBe("run-2");
      expect(await first.findByTenantIdAndThreadId("default", "thread-1")).toBeUndefined();
    },
  },
];

/** #521 AC4: a paused run and a pause whose texts hold a NUL character. */
const NUL_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: nulCaseName("a paused run's input and a pause's question"),
    run: async ({ first, second }) => {
      const base = pausedRunOf("thread-1");
      const paused = { ...base, run: { ...base.run, startInput: { text: NUL_TEXT } } };
      const ask = {
        callId: "call-1",
        tool: "charge",
        arguments: { text: NUL_TEXT },
        summary: NUL_TEXT,
      };
      const asked = { ...pauseOf("pause-a"), ask };

      await first.save(paused);
      await first.findOrCreateByStepKey(asked);

      expect(await second.findByTenantIdAndThreadId("default", "thread-1")).toEqual(paused);
      expect(await second.findByTenantIdAndPauseId("default", "pause-a")).toEqual(asked);
    },
  },
];

const STEP_KEY_CASES: readonly ContractCase<PausedExecutionRepository>[] = [
  {
    name: "a step's second try finds the first pause, with its id — on the other instance too",
    run: async ({ first, second }) => {
      const made = await first.findOrCreateByStepKey(pauseOf("pause-a"));
      const again = await second.findOrCreateByStepKey(pauseOf("pause-b"));

      expect(made).toEqual(pauseOf("pause-a"));
      expect(again.pauseId).toBe("pause-a");
      expect(await second.findByTenantIdAndPauseId("default", "pause-b")).toBeUndefined();
    },
  },
  {
    name: "#663: the step key of another tree finds none of its pauses — a pending one of its own is made",
    run: async ({ first, second }) => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await first.decideByTenantIdAndPauseId("default", "pause-a", DECIDED_ANSWER, NINE);
      const otherTree = { ...pauseOf("pause-b"), rootExecutionId: "run-2" };

      const made = await second.findOrCreateByStepKey(otherTree);
      const again = await first.findOrCreateByStepKey({ ...otherTree, pauseId: "pause-c" });

      expect(made).toEqual(otherTree);
      expect(again).toEqual(otherTree);
      expect((await second.findByTenantIdAndPauseId("default", "pause-a"))?.status).toBe(
        PauseStatus.Taken,
      );
      const ids = async (root: string) =>
        (await second.findAllByTenantIdAndRootExecutionId("default", root)).map(
          (pause) => pause.pauseId,
        );
      expect(await ids("run-1")).toEqual(["pause-a"]);
      expect(await ids("run-2")).toEqual(["pause-b"]);
    },
  },
  {
    name: "a pause is found by its tenant and id only; the tree lists its pauses",
    run: async ({ first, second }) => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));
      await first.findOrCreateByStepKey(pauseOf("pause-b", "run-1:clerk-agent:1:call-2"));

      const tree = await second.findAllByTenantIdAndRootExecutionId("default", "run-1");

      expect(tree.map((pause) => pause.pauseId).sort()).toEqual(["pause-a", "pause-b"]);
      expect(await second.findByTenantIdAndPauseId("acme", "pause-a")).toBeUndefined();
      expect(await second.findAllByTenantIdAndRootExecutionId("acme", "run-1")).toEqual([]);
    },
  },
  {
    name: "#337: its branch keys are kept as written, on the other instance too",
    run: async ({ first, second }) => {
      const branchKeys = ["run-1:refund-one-workflow:1:0", "child-1:clerk-agent:1"];

      await first.findOrCreateByStepKey({ ...pauseOf("pause-a"), branchKeys });

      expect(await second.findByTenantIdAndPauseId("default", "pause-a")).toEqual({
        ...pauseOf("pause-a"),
        branchKeys,
      });
    },
  },
  {
    name: "marking it sent changes a pending pause only",
    run: async ({ first, second }) => {
      await first.findOrCreateByStepKey(pauseOf("pause-a"));

      expect(await second.markSentByTenantIdAndPauseId("default", "pause-a", NO_RECIPIENTS)).toBe(
        true,
      );
      expect((await first.findByTenantIdAndPauseId("default", "pause-a"))?.isSent).toBe(true);
      await second.decideByTenantIdAndPauseId("default", "pause-a", DECIDED_ANSWER, NINE);
      expect(await first.markSentByTenantIdAndPauseId("default", "pause-a", NO_RECIPIENTS)).toBe(
        false,
      );
    },
  },
];

/**
 * `PausedExecutionRepository` (#265 AC7 / AC11, #267 S35 / AC3 / AC12 / S107): one paused
 * execution per thread; one pause record per step key, whatever the number of tries; exactly one
 * of two concurrent `Pending → Resolved` transitions of one pause succeeds, also from two
 * instances; `markSent` never overwrites a resolved pause; resolved records are swept by age.
 */
export function pausedExecutionContract(target: ContractTarget<PausedExecutionRepository>): void {
  registerContract(
    "paused execution contract",
    target,
    [
      { title: "paused executions by thread", cases: BY_THREAD_CASES },
      { title: "one pause per step key", cases: STEP_KEY_CASES },
      { title: "a pause goes from Pending to Resolved once", cases: PAUSE_TRANSITION_CASES },
      { title: "how each pause was resolved, and how long it is kept", cases: PAUSE_RECORD_CASES },
      { title: "texts as they were handed over", cases: NUL_CASES },
      { title: "a question role's pause, as an approval's", cases: QUESTION_PAUSE_CASES },
      { title: "the deadline is part of every closer's compare-and-set", cases: DEADLINE_CASES },
      { title: "a pause leaves Pending once, whichever closers race", cases: CLOSER_RACE_CASES },
      { title: "extend, remind, close untaken, find by step key", cases: EXTEND_CASES },
      { title: "notices are written with their change (notice)", cases: NOTICE_WRITE_CASES },
      { title: "notices keep their order per recipient (notice)", cases: NOTICE_ORDER_CASES },
      { title: "every transition writes its notices or nothing (notice)", cases: TRANSITION_CASES },
      { title: "delivery: claim, ack, retry, set aside (notice)", cases: DELIVERY_CASES },
      { title: "scans and pages", cases: [...SCAN_CASES, ...KEYSET_CASES] },
      { title: "a late closed names the first close (notice)", cases: LATE_CLOSE_CASES },
      { title: "a cursor never reuses a number", cases: CURSOR_CASES },
      { title: "retention and stale mailboxes (notice)", cases: RETENTION_CASES },
    ],
    pingOf,
  );
}
