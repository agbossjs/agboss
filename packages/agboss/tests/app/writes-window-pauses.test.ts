/**
 * #1098 A — an own-thread child (ADR-0022) resumed by an answer whose holder lost the tree inside
 * the window: the child's answered question saved its writes on the child's thread (`putWrites`),
 * the child's next checkpoint (`put`) never answered, the holder handed over. The next holder's
 * recovery finds no open pause (`waitingInterruptsOf` leaves the finished task out) and continues
 * the root from its checkpoint (`stream(null)`, no answer to forward): the child must be continued
 * from its saved writes — never read as still waiting at its old interrupt, which re-pauses the root
 * with nothing to answer, for ever. In memory and on SQLite, on the virtual clock; the saver's log
 * proves the window was reached before anything else is asserted.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  ExecutionLeaseLostError,
  ExecutionRecordRepository,
  PausedExecutionRepository,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { ends, resetRecovery, seen } from "../infrastructure/fixtures/recovery.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { instance, rejectionOf } from "./fixtures/fence-takeover.js";
import {
  PausesWindowMemoryApplication,
  pausesWindow,
  resetPausesWindow,
  WindowParentWorkflowStart,
} from "./fixtures/writes-window-pauses.application.js";
import { PausesWindowSqliteApplication } from "../infrastructure/sqlite/fixtures/writes-window-pauses-sqlite.application.js";

sqliteFilePerTest();
const memory = testWith(PausesWindowMemoryApplication, { instances: 2 });
const sqlite = testWith(PausesWindowSqliteApplication, { instances: 2 });

beforeEach(() => {
  resetPausesWindow();
  resetRecovery();
});
afterEach(resetPausesWindow);

const stepOf = (ran: string): string => ran.split("@")[0] ?? "";

const isChildThread = (thread: string): boolean => thread.includes("/child/");

/** The tree as the stores keep it: its record's status and its pauses' statuses. */
async function treeOf(app: TestApp, executionId: string, threadId: string) {
  const [record] = await app.resolve(ExecutionRecordRepository).lastTurns("default", threadId, 1);
  const pauses = await app
    .resolve(PausedExecutionRepository)
    .findAllByTenantIdAndRootExecutionId("default", executionId);
  return { status: record?.status, pauses: pauses.map((pause) => pause.status) };
}

/**
 * Runs the parent to its child's pause on `a`, answers it on `a` with the child's checkpoint after
 * the answered question cut off; resolves once `a`'s call ended with the hand-over — the saver's
 * log showing the window: the question's result writes saved on the child's thread, then the
 * child's next `put` asked for and never answered, and nothing after it.
 */
async function childCutAfterAnswer(a: TestApp, clock: VirtualClock) {
  const paused = await execute(a, WindowParentWorkflowStart, { orderId: "o-1098" });
  expect(paused.status).toBe("paused");
  const [pauseId] = pausesWindow.asked;
  pausesWindow.cut = { thread: isChildThread, namespace: "", skip: 0 };
  const from = pausesWindow.writes.length;
  const answer = { pauseId: pauseId ?? "", decision: { approved: true } };
  const failure = rejectionOf(a.resume(answer, { answeredBy: "approver-1" }));
  await passLive(clock, seconds(40));
  expect(await failure).toBeInstanceOf(ExecutionLeaseLostError);
  const during = pausesWindow.writes.slice(from);
  const hung = during.findIndex((write) => write === pausesWindow.hung);
  expect(pausesWindow.hung).toMatchObject({ op: "put", namespace: "" });
  expect(isChildThread(pausesWindow.hung?.thread ?? "")).toBe(true);
  // right before it: the child's answered question, its result saved — the window
  const saved = during[hung - 1];
  expect(saved).toMatchObject({ op: "putWrites", namespace: "" });
  expect(isChildThread(saved?.thread ?? "")).toBe(true);
  expect(saved?.channels).toContain("branch:to:window-approved-action");
  expect(during.slice(hung + 1)).toEqual([]);
  // nothing after the question ran on the holder
  expect(pausesWindow.ran.filter((ran) => !ran.startsWith("ask@"))).toEqual([]);
  return paused;
}

const cases = [
  ["in memory", memory],
  ["SQLite", sqlite],
] as const;

describe("#1098 A: an own-thread child's answered question saved, its next checkpoint never written", () => {
  for (const [store, test] of cases) {
    test(`A: the next holder continues the child from its saved answer — approved and charged once; the tree finishes (${store})`, async ({
      apps,
      clock,
    }) => {
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      const paused = await childCutAfterAnswer(a, clock);

      await passLive(clock, seconds(60));
      const seenEnds = await ends(2);

      // the child ended at its finish, then its parent at its own: each once
      expect(seenEnds.map((end) => end.finish)).toEqual([
        "window-child-workflow-finish",
        "window-parent-workflow-finish",
      ]);
      expect(seenEnds[1]?.output).toEqual({ text: "o-1098 approved, charged" });
      // the steps after the answer ran once each, under the next take of the lease
      expect(pausesWindow.ran.filter((ran) => !ran.startsWith("ask@")).map(stepOf)).toEqual([
        "approved",
        "charge",
      ]);
      // the question was not asked again: the answer saved on the child's thread was its answer
      expect(pausesWindow.asked).toHaveLength(1);
      expect((await treeOf(b, paused.executionId, paused.threadId)).status).toBe("answered");
      expect(seen.errors).toEqual([]);
    });
  }
});
