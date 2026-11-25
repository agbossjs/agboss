/**
 * #1098 B — a resume that waits for the tree's lease while its holder loses the tree inside the
 * window. A tree with two questions in a row: holder A takes the first answer; when the second
 * question is asked, instance B answers it (recorded `Resolved`) and waits for the lease; A's drain
 * takes that answer too, the answered question's writes are saved (`putWrites`) and the checkpoint
 * after them (`put`) never answers — A hands over. B's resume takes the lease and finds no open
 * pause (the answered task is left out): it must move the tree on from its checkpoint and report
 * where it is — never `NotPausedError`, a stale paused result or a `Finished` before the tree's end.
 * Cut after the second question's writes, after the next step's, and after the finish node's.
 * In memory and on SQLite, on the virtual clock; the saver's log proves the window first.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import {
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
import { ends, resetRecovery, seen } from "../infrastructure/fixtures/recovery.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { PausesWindowSqliteApplication } from "../infrastructure/sqlite/fixtures/writes-window-pauses-sqlite.application.js";
import { instance, rejectionOf } from "./fixtures/fence-takeover.js";
import {
  PausesWindowMemoryApplication,
  pausesWindow,
  resetPausesWindow,
  WindowTwiceWorkflowStart,
} from "./fixtures/writes-window-pauses.application.js";

sqliteFilePerTest();
const memory = testWith(PausesWindowMemoryApplication, { instances: 2 });
const sqlite = testWith(PausesWindowSqliteApplication, { instances: 2 });

beforeEach(() => {
  resetPausesWindow();
  resetRecovery();
});
afterEach(resetPausesWindow);

const stepOf = (ran: string): string => ran.split("@")[0] ?? "";
const isRoot = (thread: string): boolean => !thread.includes("/child/");

/**
 * Where A is cut off, after the second answer: `skip` result writes of the root's thread pass
 * first — 0: the second question's own; 1: the approval step's; 3: the finish node's — and the
 * channels the saved writes route to (what proves which task they are).
 */
const cuts = [
  { where: "the second question's writes", skip: 0, routes: "branch:to:window-approved-action" },
  { where: "the approval step's writes", skip: 1, routes: "branch:to:window-charge-action" },
  { where: "the finish node's writes", skip: 3, routes: "finish" },
] as const;

/**
 * When the second question is asked on A, the cut is armed and the channel's send waits; the
 * test (outside A's step: its own async context, as another process's call would be) has B answer
 * it, waits until the answer is recorded and lets the send go on. B's call then waits for the lease.
 */
function answerSecondFrom(b: TestApp, executionId: () => string, skip: number) {
  const call: { resumed?: Promise<ExecutionOutput> } = {};
  let asked: (pauseId: string) => void = () => undefined;
  const second = new Promise<string>((resolve) => {
    asked = resolve;
  });
  let recorded: () => void = () => undefined;
  const answered = new Promise<void>((resolve) => {
    recorded = resolve;
  });
  pausesWindow.onAsk = async (pauseId) => {
    if (pausesWindow.asked.length !== 2) return;
    // A's next pass is the one cut off: it starts with the second answer
    pausesWindow.cut = { thread: isRoot, namespace: "", skip };
    asked(pauseId);
    await answered;
  };
  void second.then(async (pauseId) => {
    const resumed = b.resume(
      { pauseId, decision: { approved: true } },
      { actor: { id: "approver-2" } },
    );
    resumed.catch(() => undefined);
    call.resumed = resumed;
    const pauses = b.resolve(PausedExecutionRepository);
    for (let tick = 0; tick < 1000; tick += 1) {
      const records = await pauses.findAllByTenantIdAndRootExecutionId("default", executionId());
      const record = records.find((each) => each.pauseId === pauseId);
      if (record?.status === PauseStatus.Resolved) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    recorded();
  });
  return call;
}

const cases = [
  ["in memory", memory],
  ["SQLite", sqlite],
] as const;

describe("#1098 B: a waiting resume takes a tree its holder lost between a task's writes and the checkpoint", () => {
  for (const [store, test] of cases) {
    for (const cut of cuts) {
      test(`B: cut after ${cut.where}: B's resume moves the tree on — approved and charged once, Finished with the output (${store})`, async ({
        apps,
        clock,
      }) => {
        const [a, b] = [instance(apps, 0), instance(apps, 1)];
        await a.ready();
        await b.ready();
        const paused = await execute(a, WindowTwiceWorkflowStart, { orderId: "o-1098" });
        expect(paused.status).toBe("paused");
        const waiting = answerSecondFrom(b, () => paused.executionId, cut.skip);
        const from = pausesWindow.writes.length;
        const first = { pauseId: pausesWindow.asked[0] ?? "", decision: { approved: true } };

        const moved = rejectionOf(a.resume(first, { actor: { id: "approver-1" } }));
        await passLive(clock, seconds(40));
        expect(await moved).toBeInstanceOf(ExecutionLeaseLostError);
        // the window: the cut task's result saved on the root's thread, its checkpoint asked for, nothing after
        const during = pausesWindow.writes.slice(from);
        const hung = during.findIndex((write) => write === pausesWindow.hung);
        expect(hung).toBeGreaterThan(0);
        expect(during[hung - 1]).toMatchObject({ op: "putWrites", namespace: "" });
        expect(during[hung - 1]?.channels).toContain(cut.routes);
        expect(during.slice(hung + 1)).toEqual([]);
        expect(waiting.resumed).toBeDefined();

        const outcome = await Promise.race([
          (waiting.resumed ?? Promise.reject(new Error("no resume"))).then(
            (output) => ({ output }),
            (error: unknown) => ({ error }),
          ),
          passLive(clock, seconds(30)).then(() => ({ timedOut: true })),
        ]);

        expect(outcome).toMatchObject({
          output: {
            status: ExecutionStatus.Finished,
            output: { text: "o-1098 approved, charged" },
          },
        });
        // each step once: the answered question is not asked again, the steps after it run once
        expect(pausesWindow.ran.map(stepOf)).toEqual(["ask", "ask-again", "approved", "charge"]);
        expect(pausesWindow.asked).toHaveLength(2);
        const [end] = await ends(1);
        expect(end).toEqual({
          finish: "window-twice-workflow-finish",
          output: { text: "o-1098 approved, charged" },
        });
        const [record] = await b
          .resolve(ExecutionRecordRepository)
          .lastTurns("default", paused.threadId, 1);
        expect(record?.status).toBe("answered");
        expect(seen.errors).toEqual([]);
      });
    }
  }
});
