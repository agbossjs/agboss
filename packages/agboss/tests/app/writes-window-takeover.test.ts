/**
 * #1090 — a tree handed over after its holder saved a task's writes (`putWrites`) and before it
 * saved the next checkpoint (`put`): the next holder applies the saved writes and runs what is
 * left, once. LangGraph leaves a task whose writes are saved out of `next`, so an empty `next` does
 * not say the graph finished. In-memory and SQLite savers, on the virtual clock.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError, SqliteConnection } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import type { VirtualClock } from "../../src/testing/clock.js";
import { processHoldPoints } from "../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged } from "../helpers/log.js";
import { ends, resetRecovery, seen } from "../infrastructure/fixtures/recovery.workflow.js";
import {
  chargesIn,
  SqliteChargeWorkflowStart,
} from "../infrastructure/sqlite/fixtures/sqlite-fenced-effect.workflow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { WritesWindowSqliteApplication } from "../infrastructure/sqlite/fixtures/writes-window-sqlite.application.js";
import { passLive } from "../helpers/live-time.js";
import { book, ChargeWorkflowStart, resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { instance, rejectionOf } from "./fixtures/fence-takeover.js";
import {
  resetWindow,
  window,
  WritesWindowMemoryApplication,
} from "./fixtures/writes-window.application.js";

sqliteFilePerTest();
const memory = testWith(WritesWindowMemoryApplication, { instances: 2 });
const sqlite = testWith(WritesWindowSqliteApplication, { instances: 2 });

beforeEach(() => {
  resetWindow();
  resetFencedEffect();
  resetRecovery();
  logged.length = 0;
});

afterEach(() => {
  resetWindow();
  processHoldPoints.releaseAll();
});

/**
 * Where the holder is cut off. The graph saves a checkpoint (`put`) before its first task and after
 * each of its four tasks (the init, the start node, the charge, the finish), and the task's writes
 * (`putWrites`) before the checkpoint that follows it: `inside` is the calls that reached the saver
 * when the holder gave up — `puts` equal to `writes` is the window itself, a task's writes saved
 * and the next checkpoint not asked for yet.
 * - `put`: the `put` of that number never answers, the holder hands over at the end of its trust;
 * - `silentLeases`: every lease renewal never answers (the lease store went silent, from the start):
 *   each ends at its 5 s bound, and the holder, its 30 s lease over, stops before its third
 *   checkpoint, right after the start node's writes; the clock moves in seconds so the calls follow in turn.
 */
const cuts = [
  {
    where: "the first task's writes (the input checkpoint is saved, the init task's writes hang)",
    write: 1,
    inside: undefined,
  },
  {
    where:
      "the input checkpoint only (the init task's writes and the checkpoint after them never answer: nothing but the run's input is stored)",
    write: 1,
    put: 2,
    inside: { puts: 2, writes: 0 },
  },
  { where: "the put after the init task's writes hangs", put: 2, inside: { puts: 2, writes: 1 } },
  { where: "the put after the start node's writes hangs", put: 3, inside: { puts: 3, writes: 2 } },
  { where: "the put after the charge's writes hangs", put: 4, inside: { puts: 4, writes: 3 } },
  { where: "the put after the finish node's writes hangs", put: 5, inside: { puts: 5, writes: 4 } },
  {
    where: "every lease renewal stops answering (the holder stops asking for the next checkpoint)",
    silentLeases: true,
    inside: { puts: 2, writes: 2 },
  },
] as const;

type Cut = (typeof cuts)[number];

/** Runs the order into the cut; resolves once the holder's call ended with the hand-over. */
async function cutAt(cut: Cut, clock: VirtualClock, run: () => Promise<unknown>): Promise<void> {
  if ("write" in cut) window.hangWrite = cut.write;
  if ("put" in cut) window.hangPut = cut.put;
  if (!("write" in cut) && !("put" in cut))
    processHoldPoints.arm({ point: StoreHoldPoint.LeaseRenew, times: 1000 });
  // the saver's counts at the moment the holder's call ended: the next holder has not moved yet
  const failure = rejectionOf(run()).then((error: unknown) => ({ error, ...window }));
  if ("put" in cut) await passLive(clock, seconds(40));
  else for (let second = 0; second < 40; second += 1) await clock.advance(seconds(1));
  const ended = await failure;
  expect(ended.error).toBeInstanceOf(ExecutionLeaseLostError);
  // the run wrote its first checkpoint: this is a plain hand-over, not "did not start"
  expect((ended.error as ExecutionLeaseLostError).code).toBe("execution.lease-lost");
  if (cut.inside !== undefined)
    expect({ puts: ended.puts, writes: ended.writes }).toEqual(cut.inside);
  window.hangPut = 0;
  window.hangWrite = 0;
  processHoldPoints.releaseAll();
}

// under a loaded gate (3 workers beside other gates) a case here ran 5.7-11 s against vitest's 5 s default, and 0.6-3 s alone (#1225, as #1160): the bound says "not hung"
describe(
  "#1090: a hand-over between a task's writes and the next checkpoint",
  { timeout: 60_000 },
  () => {
    for (const cut of cuts) {
      const name = `${cut.where}: the next holder applies the saved writes, charges once, finishes the tree`;

      memory(`${name} (in memory)`, async ({ apps, clock }) => {
        const [a, b] = [instance(apps, 0), instance(apps, 1)];
        await a.ready();
        await b.ready();

        await cutAt(cut, clock, () => execute(a, ChargeWorkflowStart, { text: "order-1090" }));
        await passLive(clock, seconds(60));
        const [end] = await ends(1);

        expect(book.charges.map((row) => row.order)).toEqual(["order-1090"]);
        expect(end?.output).toEqual({ chargeId: book.charges[0]?.chargeId });
        expect(seen.errors).toEqual([]);
      });

      sqlite(`${name} (SQLite)`, async ({ apps, clock }) => {
        const [a, b] = [instance(apps, 0), instance(apps, 1)];
        await a.ready();
        await b.ready();
        const rows = (): readonly string[] => chargesIn(b.resolve(SqliteConnection).database);

        await cutAt(cut, clock, () =>
          execute(a, SqliteChargeWorkflowStart, { text: "order-1090" }),
        );
        await passLive(clock, seconds(60));
        const [end] = await ends(1);

        expect(rows()).toHaveLength(1);
        expect(end?.output).toEqual({ chargeId: rows()[0] });
        expect(seen.errors).toEqual([]);
      });
    }
  },
);
