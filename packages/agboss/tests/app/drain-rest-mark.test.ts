/**
 * #1187 — a drain that rested goes on with an answer recorded meanwhile: its pass 1 ends with the
 * rest (`paused`, an unconditional write), its pass 2 takes the answer. The record must say
 * `running` before pass 2, or a holder killed there leaves a `paused` root beside an answer it took —
 * no recovery (only `running` records), no resume (the pause is not pending): stuck for ever.
 * - the held-write twin of scenario 27b: the rest lands after the waiting resume's mark (as
 *   on PostgreSQL), so only the drain's own mark makes the record `running` for the resume;
 * - a kill in the drain's second pass, the resume's caller gone: the sweep continues the tree;
 * - a kill between the rest write and the drain's mark, the resume's caller gone: the sweep's look
 *   at the open pauses wakes the root under its lease, and recovery takes the answer once.
 * On SQLite (two instances, one file), on the virtual clock; the record writes' log proves each window first.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ApplicationContext,
  ExecutionLeaseLostError,
  ExecutionRecordRepository,
  PausedExecutionRepository,
  PauseStatus,
  type ExecutionOutput,
} from "../../src/index.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { ends, kill, resetRecovery, seen } from "../infrastructure/fixtures/recovery.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { PausesWindowSqliteApplication } from "../infrastructure/sqlite/fixtures/writes-window-pauses-sqlite.application.js";
import { instance, rejectionOf } from "./fixtures/fence-takeover.js";
import {
  pausesWindow,
  resetPausesWindow,
  WindowTwiceWorkflowStart,
  type RecordWrite,
} from "./fixtures/writes-window-pauses.application.js";

sqliteFilePerTest();
const sqlite = testWith(PausesWindowSqliteApplication, { instances: 2 });

/** Lets a write held by a dead instance go at the end, so the apps close. */
const held: { release: () => void } = { release: () => undefined };

beforeEach(() => {
  resetPausesWindow();
  resetRecovery();
});
afterEach(() => {
  held.release();
  resetPausesWindow();
});

const stepOf = (ran: string): string => ran.split("@")[0] ?? "";
const isRoot = (thread: string): boolean => !thread.includes("/child/");
const idOf = (app: TestApp): string => app.resolve(ApplicationContext).instanceId;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The record writes since the second question was asked (`from`: the log's length then). */
const writesSince = (from: number): readonly RecordWrite[] => pausesWindow.records.slice(from);

/**
 * Holds A's rest after the second question (its pass 1 wrote `paused`, not landed yet): B answers
 * the question meanwhile — outside A's pass, as another process's call would — so A's drain finds
 * the answer only after its rest, the order of #1187. With `gone` B's call is aborted once its
 * answer is recorded: its caller is gone, nothing waits to take the tree. A's write lands once B's
 * call recorded its answer and, unless it is gone, made its mark (it lands before the rest,
 * as on PostgreSQL; its second, under the lease, is made after the take, #1179). `restAt` is the record log's length when the rest was held.
 */
function restHeldWhileBAnswers(a: TestApp, b: TestApp, executionId: () => string, gone: boolean) {
  const state: { resumed?: Promise<ExecutionOutput>; restAt?: number } = {};
  let onRest: () => void = () => undefined;
  const rest = new Promise<void>((resolve) => {
    onRest = resolve;
  });
  let onAnswered: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    onAnswered = resolve;
  });
  pausesWindow.beforeRecordWrite = async (write) => {
    const isRest = write.op === "complete" && write.status === "paused";
    if (!isRest || write.instanceId !== idOf(a) || pausesWindow.asked.length !== 2) return;
    if (state.restAt !== undefined) return;
    state.restAt = pausesWindow.records.length;
    onRest();
    await answered;
  };
  void rest.then(async () => {
    const pauseId = pausesWindow.asked[1] ?? "";
    const caller = new AbortController();
    const options = { answeredBy: "approver-2", signal: caller.signal };
    const resumed = b.resume({ pauseId, decision: { approved: true } }, options);
    resumed.catch(() => undefined);
    state.resumed = resumed;
    const pauses = b.resolve(PausedExecutionRepository);
    for (let turn = 0; turn < 1000; turn += 1) {
      const records = await pauses.findAllByTenantIdAndRootExecutionId("default", executionId());
      const isRecorded = records.some(
        (one) => one.pauseId === pauseId && one.status === PauseStatus.Resolved,
      );
      const marks = writesSince(state.restAt ?? 0).filter((one) => one.instanceId === idOf(b));
      if (isRecorded && (gone || marks.length >= 1)) break;
      await tick();
    }
    if (gone) {
      caller.abort(new Error("the resume's caller is gone"));
      await rejectionOf(resumed);
    }
    onAnswered();
  });
  return state;
}

/** Runs the order to its first question on `a` and answers it there; its call, in the background. */
async function firstAnswered(a: TestApp) {
  const paused = await execute(a, WindowTwiceWorkflowStart, { orderId: "o-1187" });
  expect(paused.status).toBe("paused");
  const first = { pauseId: pausesWindow.asked[0] ?? "", decision: { approved: true } };
  return { paused, moved: rejectionOf(a.resume(first, { answeredBy: "approver-1" })) };
}

/** The tree ended at its finish, approved and charged once, its record answered, no error. */
async function finishedOnce(b: TestApp, threadId: string): Promise<void> {
  const [end] = await ends(1);
  expect(end).toEqual({
    finish: "window-twice-workflow-finish",
    output: { text: "o-1187 approved, charged" },
  });
  expect(pausesWindow.ran.map(stepOf).filter((step) => step === "charge")).toHaveLength(1);
  expect(pausesWindow.asked).toHaveLength(2);
  const [record] = await b.resolve(ExecutionRecordRepository).lastTurns("default", threadId, 1);
  expect(record?.status).toBe("answered");
  expect(seen.errors).toEqual([]);
}

/**
 * On SQLite only: each instance has its own stores over the one file, so a record write and a lease
 * are told apart by their instance and an instance is killed alone. In memory the listed stores are
 * one instance for the whole test (`TestEnvironment`), the first instance's.
 */
const cases = [["SQLite", sqlite]] as const;

/** The record writes since the rest was held, as `<who>:<op>:<status>` (`a`, `b`). */
const traceOf = (a: TestApp, from: number): readonly string[] =>
  writesSince(from).map(
    (one) => `${one.instanceId === idOf(a) ? "a" : "b"}:${one.op}:${one.status}`,
  );

describe("#1187: a drain's later pass runs with its record marked running", () => {
  for (const [store, test] of cases) {
    test(`AC1 (the held-write twin of 27b): the rest lands after the waiting resume's mark — the drain marks the record running again, so the resume moves the tree on (${store})`, async ({
      apps,
      clock,
    }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      const { paused, moved } = await firstAnswered(a);
      const waiting = restHeldWhileBAnswers(a, b, () => paused.executionId, false);
      // a's pass 2 is cut after the second answer's writes: a hand-over there
      pausesWindow.onAsk = (): Promise<void> => {
        if (pausesWindow.asked.length === 2)
          pausesWindow.cut = { thread: isRoot, namespace: "", skip: 0 };
        return Promise.resolve();
      };

      await passLive(clock, seconds(40));
      expect(await moved).toBeInstanceOf(ExecutionLeaseLostError);
      // the window: b's mark (a no-op, the record was running), then a's rest over it, then a's mark;
      // b's own mark again waits for the lease (#1179), so it cannot land on a rest
      expect(traceOf(a, waiting.restAt ?? 0)).toEqual([
        "b:mark:running",
        "a:complete:paused",
        "a:mark:running",
      ]);
      const outcome = await Promise.race([
        (waiting.resumed ?? Promise.reject(new Error("no resume"))).then((output) => ({ output })),
        passLive(clock, seconds(30)).then(() => ({ timedOut: true })),
      ]);

      expect(outcome).toMatchObject({ output: { status: ExecutionStatus.Finished } });
      await finishedOnce(b, paused.threadId);
    });

    test(`AC2: the holder killed in the drain's second pass, the resume's caller gone — the sweep continues the tree, charged once (${store})`, async ({
      apps,
      clock,
    }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      const { paused, moved } = await firstAnswered(a);
      const waiting = restHeldWhileBAnswers(a, b, () => paused.executionId, true);
      // a dies at its second pass's approval step (the answer taken): it renews and writes nothing more
      pausesWindow.onApproved = (instanceId) => {
        if (instanceId === idOf(a)) kill(instanceId);
      };

      await passLive(clock, seconds(40));
      expect(await moved).toBeInstanceOf(ExecutionLeaseLostError);
      // the window: a's rest, its mark, then the pass it was killed in (the answer taken there)
      const trace = traceOf(a, waiting.restAt ?? 0).filter((one) => one.startsWith("a:"));
      expect(trace).toEqual(["a:complete:paused", "a:mark:running"]);
      expect(pausesWindow.ran).toContain(`approved@${idOf(a)}`);
      await passLive(clock, seconds(90));

      await finishedOnce(b, paused.threadId);
      expect(pausesWindow.ran).toContain(`charge@${idOf(b)}`);
    });

    test(`AC3 (the gap): the holder killed between its rest write and its mark, the resume's caller gone — the sweep wakes the root under its lease and recovery takes the answer once (${store})`, async ({
      apps,
      clock,
    }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      const { paused, moved } = await firstAnswered(a);
      const waiting = restHeldWhileBAnswers(a, b, () => paused.executionId, true);
      const holdRest = pausesWindow.beforeRecordWrite;
      let secondAtKill: string | undefined;
      // after its rest lands, a dies before its mark, which it never makes
      pausesWindow.beforeRecordWrite = async (write) => {
        const isAfterRest = waiting.restAt !== undefined && write.instanceId === idOf(a);
        if (isAfterRest && write.op === "mark") {
          kill(idOf(a));
          const atKill = await b
            .resolve(PausedExecutionRepository)
            .findAllByTenantIdAndRootExecutionId("default", paused.executionId);
          secondAtKill = atKill.find((pause) => pause.pauseId === pausesWindow.asked[1])?.status;
          await new Promise<void>((resolve) => {
            held.release = resolve;
          });
          return;
        }
        await holdRest?.(write);
      };

      await passLive(clock, seconds(40));
      // the window: a's rest is the last of its writes, b's answer recorded and untaken, a dead
      const trace = traceOf(a, waiting.restAt ?? 0).filter((one) => one.startsWith("a:"));
      expect(trace).toEqual(["a:complete:paused"]);
      // b's answer recorded and not taken when a died
      expect(secondAtKill).toBe(PauseStatus.Resolved);
      await passLive(clock, seconds(120));

      await finishedOnce(b, paused.threadId);
      expect(pausesWindow.ran.filter((ran) => stepOf(ran) === "approved")).toEqual([
        `approved@${idOf(b)}`,
      ]);
      void moved;
    });
  }
});
