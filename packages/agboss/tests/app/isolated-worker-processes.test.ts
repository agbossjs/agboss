/**
 * #1286b (D9): `ChildPlacement.IsolatedWorker` across the process boundary, with real processes over one
 * SQLite file. The child runs in a fork — another pid, its own `instanceId`; a cancel reaches the fork;
 * the spend the fork records is in the same ledger, counted once; a fork that dies is a lost lease the
 * child is taken over from, in a new fork; a pause ends the fork and the resume starts another;
 * and the application's close ends its forks (no zombie). `isolated-worker-process.ts` is the process.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNodeReporting } from "../helpers/process.js";

const SCRIPT = fileURLToPath(new URL("./isolated-worker-process.ts", import.meta.url));
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "isolated-worker-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Line {
  readonly phase: string;
  readonly pid: number;
  readonly instanceId?: string;
  readonly executionId?: string;
}

interface Summary {
  readonly driver: { readonly pid: number; readonly instanceId: string };
  readonly lines: readonly Line[];
  readonly ledger: Readonly<Record<string, number>>;
  readonly alive: Readonly<Record<string, boolean>>;
  readonly status?: string;
  readonly output?: { readonly name: string };
  readonly spend?: number;
  readonly cancelled?: boolean;
  readonly firstFork?: number;
  readonly resumedStatus?: string;
  readonly killed?: number;
  readonly forkPid?: number;
  readonly forkAliveAfterClose?: boolean;
}

/** One run of the driver in `mode` to its end. */
async function drive(mode: string): Promise<Summary> {
  const run = await runNodeReporting(["--import", "tsx", SCRIPT, dir, mode]);
  if (run.status !== 0)
    throw new Error(`the driver failed (${String(run.status)}):\n${run.stderr}\n${run.stdout}`);
  return run.messages[0] as Summary;
}

const phases = (summary: Summary, phase: string): readonly Line[] =>
  summary.lines.filter((line) => line.phase === phase);

describe("#1286b: an IsolatedWorker child runs in a process of its own", () => {
  it("runs in a fork with its own pid and instanceId; its spend is in the same ledger, once", async () => {
    const summary = await drive("run");

    expect(summary.status).toBe("finished");
    expect(summary.output).toEqual({ name: "a" });
    const [start] = phases(summary, "start");
    expect(phases(summary, "start")).toHaveLength(1);
    expect(start?.pid).not.toBe(summary.driver.pid);
    expect(start?.instanceId).not.toBe(summary.driver.instanceId);
    // the fork paid 0.25 USD: the tree's counters hold it once, never twice
    expect(summary.ledger.application).toBeCloseTo(0.25, 5);
    expect(summary.ledger.execution).toBeCloseTo(0.25, 5);
    expect(summary.spend).toBeCloseTo(0.25, 5);
    // the fork ended with its child
    expect(summary.alive[String(start?.pid)]).toBe(false);
  }, 60_000);

  it("a cancel of the execution reaches the fork: its step is aborted and its process ends", async () => {
    const summary = await drive("cancel");

    expect(summary.cancelled).toBe(true);
    expect(summary.status).toBe("cancelled");
    const [aborted] = phases(summary, "aborted");
    expect(aborted?.pid).not.toBe(summary.driver.pid);
    expect(phases(summary, "done")).toEqual([]);
    expect(summary.alive[String(aborted?.pid)]).toBe(false);
  }, 90_000);

  it("a pause ends the fork and the resume starts another, the child keeping its execution", async () => {
    const summary = await drive("pause");

    expect(summary.status).toBe("paused");
    expect(summary.resumedStatus).toBe("finished");
    expect(summary.output).toEqual({ name: "a" });
    const [probe] = phases(summary, "start");
    const [recorded] = phases(summary, "recorded");
    expect(phases(summary, "start")).toHaveLength(1);
    expect(summary.firstFork).toBe(probe?.pid);
    // the step after the pause ran in another process than the one before it, neither the driver
    expect(recorded?.pid).not.toBe(probe?.pid);
    expect(recorded?.pid).not.toBe(summary.driver.pid);
    expect(recorded?.instanceId).not.toBe(probe?.instanceId);
    expect(summary.alive[String(recorded?.pid)]).toBe(false);
  }, 90_000);

  it("a fork killed mid-step is a lost lease: the child is taken over and finished in a new fork", async () => {
    const summary = await drive("crash");

    expect(summary.status).toBe("finished");
    expect(summary.output).toEqual({ name: "hold" });
    const starts = phases(summary, "start");
    const [done] = phases(summary, "done");
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts[0]?.pid).toBe(summary.killed);
    expect(done?.pid).not.toBe(summary.killed);
    expect(done?.pid).not.toBe(summary.driver.pid);
    expect(done?.executionId).toBe(starts[0]?.executionId);
    expect(summary.alive[String(summary.killed)]).toBe(false);
  }, 150_000);

  it("closing the application ends its forks: none is left running", async () => {
    const summary = await drive("teardown");

    expect(summary.forkPid).toBeGreaterThan(0);
    expect(summary.forkPid).not.toBe(summary.driver.pid);
    expect(summary.forkAliveAfterClose).toBe(false);
  }, 90_000);
});
