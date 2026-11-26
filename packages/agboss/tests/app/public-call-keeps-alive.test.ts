/**
 * #1093: a pending public call keeps the process alive until it settles. `app.cancel` of a thread
 * whose tree another instance holds waits for the lease on `Clock.sleep`, whose timers are unref'd:
 * in a script that only calls it, Node exited with code 13 in the middle of the call. Two real
 * processes on one SQLite file: this one holds the tree's lease, the child only cancels.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import type { App } from "../../src/index.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { hours } from "../../src/units/index.js";
import { PlainWorkflowStart, ShortExpiryWorkflowStart } from "../flow/fixtures/expiry.fixture.js";
import { execute } from "../helpers/flow.js";
import { startNode, type ProcessRun } from "../helpers/process.js";
import { HeldCancelApplication } from "./fixtures/held-cancel/held-cancel.application.js";

const SCRIPT = fileURLToPath(new URL("./fixtures/held-cancel/cancel-process.ts", import.meta.url));
const folder = mkdtempSync(join(tmpdir(), "agboss-held-cancel-"));
let opened: App[] = [];
/** What the holder did with its lease: a failed release leaves the child waiting for an hour's lease (#1264). */
let holder = "the holder has not let go yet";

afterEach(async () => {
  for (const app of opened) await app.close();
  opened = [];
});
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A paused thread on a fresh file whose tree this process holds for `heldFor` ms of real time. */
async function heldThread(file: string, heldFor: number): Promise<{ pauseId: string }> {
  const app = await createTestAppWith(HeldCancelApplication, {
    env: "dev",
    processEnv: { HELD_CANCEL_SQLITE_PATH: file },
  });
  opened.push(app);
  const paused = await execute(app, PlainWorkflowStart, { orderId: "o-1" }, { threadId: "held-1" });
  const leases = app.resolve(ExecutionLeaseRepository);
  const lease = await leases.acquire("default", paused.executionId, hours(1));
  // a holder busy with the tree: it lets go after a while, as its drain would
  holder = "the holder has not let go yet";
  setTimeout(() => {
    if (lease === undefined) return;
    leases.release(lease).then(
      () => {
        holder = "the holder let go";
      },
      (error: unknown) => {
        holder = `the holder's release failed: ${String(error)}`;
      },
    );
  }, heldFor);
  const [pause] = await app
    .resolve(PausedExecutionRepository)
    .findAllByTenantIdAndRootExecutionId("default", paused.executionId);
  const pauseId = pause?.pauseId;
  if (pauseId === undefined) throw new Error("the run is not paused");
  return { pauseId };
}

/** The longest the child may take: far over its 1.5 s wait, under the test's 60 s, so a hung child is reported, not timed out. */
const CHILD_DEADLINE = 40_000;

/** The script on `file`: it opens the app and makes one call; a child still running at the deadline is killed and said so. */
async function runScript(file: string, operation: string, id: string): Promise<ProcessRun> {
  const child = startNode(["--import", "tsx", SCRIPT, operation, id], {
    env: { ...process.env, HELD_CANCEL_SQLITE_PATH: file },
  });
  let deadline: NodeJS.Timeout | undefined;
  const hung = new Promise<"hung">((resolve) => {
    deadline = setTimeout(() => {
      resolve("hung");
    }, CHILD_DEADLINE);
  });
  const outcome = await Promise.race([child.exited, hung]);
  clearTimeout(deadline);
  if (outcome !== "hung") return outcome;
  child.process.kill("SIGKILL");
  const killed = await child.exited;
  return { ...killed, stderr: `HUNG for ${String(CHILD_DEADLINE)} ms, killed\n${killed.stderr}` };
}

/** What a failed run shows (#1264): how the child ended and the tail of what it wrote to stderr and stdout. */
const ended = (run: ProcessRun): string =>
  `child ended with status ${String(run.status)}, signal ${String(run.signal)}\n` +
  `${holder}\nstderr tail: ${run.stderr.slice(-2000) || "(empty)"}\nstdout tail: ${run.stdout.slice(-500) || "(empty)"}`;

describe("#1093: a pending public call keeps the process alive", () => {
  it.each([1, 2, 3])(
    "run %i: a script that only calls app.cancel on a tree another instance holds prints the result and exits 0",
    async (run) => {
      const file = join(folder, `held-${String(run)}.sqlite`);
      await heldThread(file, 1500);

      const child = await runScript(file, "cancel", "held-1");

      expect(child.status, ended(child)).toBe(0);
      expect(child.stdout, ended(child)).toContain('result {"cancelled":true}');
      expect(child.stdout, ended(child)).toContain("closed");
    },
    60_000,
  );

  it("a script that only calls app.resume on a tree another instance holds prints the result and exits 0", async () => {
    const file = join(folder, "held-resume.sqlite");
    const { pauseId } = await heldThread(file, 1500);

    const child = await runScript(file, "resume", pauseId);

    expect(child.status, ended(child)).toBe(0);
    expect(child.stderr, ended(child)).not.toContain("Error");
    expect(child.stdout, ended(child)).toContain("result finished=true");
    expect(child.stdout, ended(child)).toContain("closed");
  }, 60_000);

  // the fixture's store takes a second over the extension on Clock.sleep (an unref'd timer), as a slow database does:
  // the call settles in a script that does nothing else only while the wrapper keeps it alive
  it("a script that only calls app.setPauseTimeout prints the result and exits 0", async () => {
    const file = join(folder, "held-extend.sqlite");
    const app = await createTestAppWith(HeldCancelApplication, {
      env: "dev",
      processEnv: { HELD_CANCEL_SQLITE_PATH: file },
    });
    opened.push(app);
    const paused = await execute(app, ShortExpiryWorkflowStart, { orderId: "o-2" });
    const [pause] = await app
      .resolve(PausedExecutionRepository)
      .findAllByTenantIdAndRootExecutionId("default", paused.executionId);

    const child = await runScript(file, "extend", pause?.pauseId ?? "");

    expect(child.status, ended(child)).toBe(0);
    expect(child.stderr, ended(child)).not.toContain("Error");
    expect(child.stdout, ended(child)).toContain("result extended=true");
  }, 60_000);

  // #946: the reassignment's transaction is as slow, and its new send follows it
  it("a script that only calls app.reassignPause prints the result and exits 0", async () => {
    const file = join(folder, "held-reassign.sqlite");
    const app = await createTestAppWith(HeldCancelApplication, {
      env: "dev",
      processEnv: { HELD_CANCEL_SQLITE_PATH: file },
    });
    opened.push(app);
    const paused = await execute(app, ShortExpiryWorkflowStart, { orderId: "o-3" });
    const [pause] = await app
      .resolve(PausedExecutionRepository)
      .findAllByTenantIdAndRootExecutionId("default", paused.executionId);

    const child = await runScript(file, "reassign", pause?.pauseId ?? "");

    expect(child.status, ended(child)).toBe(0);
    expect(child.stderr, ended(child)).not.toContain("Error");
    expect(child.stdout, ended(child)).toContain("result reassigned=true");
  }, 60_000);
});
