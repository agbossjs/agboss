/**
 * #1286b: one real application process with `IsolatedWorker` children over a SQLite file, driven by
 * `isolated-worker-processes.test.ts`: `node --import tsx isolated-worker-process.ts <dir> <mode>`.
 * Its forks (real processes of `isolated-fork-main`) log into `<dir>/probe.log`; the process reports
 * one message over IPC (#1128): what ran where, how the execution ended, the ledger's counters, and
 * which pids were alive at the end.
 *   run       — one isolated child runs to its end.
 *   cancel    — a child holds; the execution is cancelled.
 *   pause     — a child pauses at a question in its fork; the answer is resumed.
 *   crash     — a child holds; its fork is killed (SIGKILL) and the child is taken over and finished.
 *   teardown  — a child holds; the application closes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createAppWith } from "../../src/application/create-app.js";
import { ApplicationContext } from "../../src/index.js";
import { seconds } from "../../src/units/index.js";
import { report } from "../helpers/child-channel.js";
import { execute } from "../helpers/flow.js";
import {
  IsolatedAskRootWorkflowStart,
  IsolatedProcessApplication,
  IsolatedRunRootWorkflowStart,
} from "../infrastructure/sqlite/fixtures/isolated-worker.application.js";

const [dir = "", mode = ""] = process.argv.slice(2);
const file = join(dir, "app.sqlite");
process.env.AGBOSS_SQLITE_TEST_PATH = file;
process.env.AGBOSS_ISOLATED_TEST_DIR = dir;

interface Line {
  readonly phase: string;
  readonly pid: number;
  readonly instanceId?: string;
  readonly executionId?: string;
  readonly pauseId?: string;
}

const lines = (): readonly Line[] => {
  const path = join(dir, "probe.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((text) => text !== "")
    .map((text) => JSON.parse(text) as Line);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls `condition` until it holds; the test's own timeout bounds it. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await sleep(50);
}

/** What each budget scope's counter holds, read on a connection of its own. */
function ledger(): Record<string, number> {
  const database = new DatabaseSync(file);
  try {
    const rows = database
      .prepare("SELECT scope, SUM(spent_usd) AS spent FROM cost_ledger GROUP BY scope")
      .all() as { scope: string; spent: number }[];
    return Object.fromEntries(rows.map((row) => [row.scope, row.spent]));
  } finally {
    database.close();
  }
}

const item = (name: string) => ({ name, delay: 0, outcome: "ok" });
const app = await createAppWith(IsolatedProcessApplication, { processEnv: process.env });
const here = app.resolve(ApplicationContext).instanceId;
const startedBy = (phase: string): Line | undefined => lines().find((one) => one.phase === phase);

async function summary(extra: Record<string, unknown>): Promise<void> {
  const pids = [...new Set(lines().map((one) => one.pid))];
  await report({
    driver: { pid: process.pid, instanceId: here },
    lines: lines(),
    ledger: ledger(),
    alive: Object.fromEntries(pids.map((pid) => [pid, isAlive(pid)])),
    ...extra,
  });
}

if (mode === "run") {
  const out = await execute(app, IsolatedRunRootWorkflowStart, item("a"));
  await summary({ status: out.status, output: out.output, spend: out.spend.totalUsd });
} else if (mode === "cancel") {
  const call = execute(app, IsolatedRunRootWorkflowStart, item("hold"), { threadId: "t-cancel" });
  call.catch(() => undefined);
  await until(() => startedBy("start") !== undefined);
  const forkPid = startedBy("start")?.pid ?? 0;
  const cancelled = await app.cancel("t-cancel");
  const out = await call.catch((error: unknown) => ({ status: `rejected: ${String(error)}` }));
  await until(() => lines().some((one) => one.phase === "aborted"));
  await until(() => !isAlive(forkPid));
  await summary({ cancelled: cancelled.cancelled, status: out.status });
} else if (mode === "pause") {
  const paused = await execute(app, IsolatedAskRootWorkflowStart, item("a"), {
    threadId: "t-pause",
  });
  const asked = lines().find((one) => one.phase === "asked");
  await until(() => !isAlive(asked?.pid ?? 0));
  const afterPause = { status: paused.status, firstFork: asked?.pid };
  const done = await app.resume(
    {
      pauseId: asked?.pauseId ?? "",
      decision: { approved: true },
    },
    { actor: { id: "reviewer-1" } },
  );
  await summary({ ...afterPause, resumedStatus: done.status, output: done.output });
} else if (mode === "crash") {
  const call = execute(app, IsolatedRunRootWorkflowStart, item("hold"), { threadId: "t-crash" });
  call.catch(() => undefined);
  await until(() => startedBy("start") !== undefined);
  const killed = startedBy("start")?.pid ?? 0;
  process.kill(killed, "SIGKILL");
  writeFileSync(join(dir, "release"), "");
  const out = await call;
  await summary({ killed, status: out.status, output: out.output });
} else {
  const call = execute(app, IsolatedRunRootWorkflowStart, item("hold"), { threadId: "t-stop" });
  call.catch(() => undefined);
  await until(() => startedBy("start") !== undefined);
  const forkPid = startedBy("start")?.pid ?? 0;
  await app.close({ timeout: seconds(5) });
  // the fork is ended at the stop's deadline (SIGKILL): gone within a moment of close() returning
  for (let wait = 0; wait < 100 && isAlive(forkPid); wait += 1) await sleep(50);
  await summary({ forkPid, forkAliveAfterClose: isAlive(forkPid) });
}
await app.close().catch(() => undefined);
process.exit(0);
