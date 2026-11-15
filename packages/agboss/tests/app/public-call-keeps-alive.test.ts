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
import { createAppWith } from "../../src/application/create-app.js";
import type { App } from "../../src/index.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { hours } from "../../src/units/index.js";
import { PlainWorkflowStart, ShortExpiryWorkflowStart } from "../flow/fixtures/expiry.fixture.js";
import { execute } from "../helpers/flow.js";
import { runProcess } from "../helpers/process.js";
import { HeldCancelApplication } from "./fixtures/held-cancel/held-cancel.application.js";

const SCRIPT = fileURLToPath(new URL("./fixtures/held-cancel/cancel-process.ts", import.meta.url));
const folder = mkdtempSync(join(tmpdir(), "agboss-held-cancel-"));
let opened: App[] = [];

afterEach(async () => {
  for (const app of opened) await app.close();
  opened = [];
});
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A paused thread on a fresh file whose tree this process holds for `heldFor` ms of real time. */
async function heldThread(file: string, heldFor: number): Promise<{ pauseId: string }> {
  const app = await createAppWith(HeldCancelApplication, {
    env: "dev",
    processEnv: { HELD_CANCEL_SQLITE_PATH: file },
  });
  opened.push(app);
  const paused = await execute(app, PlainWorkflowStart, { orderId: "o-1" }, { threadId: "held-1" });
  const leases = app.resolve(ExecutionLeaseRepository);
  const lease = await leases.acquire("default", paused.executionId, hours(1));
  // a holder busy with the tree: it lets go after a while, as its drain would
  setTimeout(() => {
    if (lease !== undefined) void leases.release(lease);
  }, heldFor);
  const [pause] = await app
    .resolve(PausedExecutionRepository)
    .findAllByTenantIdAndRootExecutionId("default", paused.executionId);
  const pauseId = pause?.pauseId;
  if (pauseId === undefined) throw new Error("the run is not paused");
  return { pauseId };
}

/** The script on `file`: it opens the app and makes one call. */
const runScript = (file: string, operation: string, id: string) =>
  runProcess(process.execPath, ["--import", "tsx", SCRIPT, operation, id], {
    env: { ...process.env, HELD_CANCEL_SQLITE_PATH: file },
  });

describe("#1093: a pending public call keeps the process alive", () => {
  it.each([1, 2, 3])(
    "run %i: a script that only calls app.cancel on a tree another instance holds prints the result and exits 0",
    async (run) => {
      const file = join(folder, `held-${String(run)}.sqlite`);
      await heldThread(file, 1500);

      const child = await runScript(file, "cancel", "held-1");

      expect(child.stdout).toContain('result {"cancelled":true}');
      expect(child.stdout).toContain("closed");
      expect(child.status).toBe(0);
    },
    60_000,
  );

  it("a script that only calls app.resume on a tree another instance holds prints the result and exits 0", async () => {
    const file = join(folder, "held-resume.sqlite");
    const { pauseId } = await heldThread(file, 1500);

    const child = await runScript(file, "resume", pauseId);

    expect(child.stderr).not.toContain("Error");
    expect(child.stdout).toContain("result finished=true");
    expect(child.stdout).toContain("closed");
    expect(child.status).toBe(0);
  }, 60_000);

  // the fixture's store takes a second over the extension on Clock.sleep (an unref'd timer), as a slow database does:
  // the call settles in a script that does nothing else only while the wrapper keeps it alive
  it("a script that only calls app.extendPause prints the result and exits 0", async () => {
    const file = join(folder, "held-extend.sqlite");
    const app = await createAppWith(HeldCancelApplication, {
      env: "dev",
      processEnv: { HELD_CANCEL_SQLITE_PATH: file },
    });
    opened.push(app);
    const paused = await execute(app, ShortExpiryWorkflowStart, { orderId: "o-2" });
    const [pause] = await app
      .resolve(PausedExecutionRepository)
      .findAllByTenantIdAndRootExecutionId("default", paused.executionId);

    const child = await runScript(file, "extend", pause?.pauseId ?? "");

    expect(child.stderr).not.toContain("Error");
    expect(child.stdout).toContain("result extended=true");
    expect(child.status).toBe(0);
  }, 60_000);

  // #946: the reassignment's transaction is as slow, and its new send follows it
  it("a script that only calls app.reassignPause prints the result and exits 0", async () => {
    const file = join(folder, "held-reassign.sqlite");
    const app = await createAppWith(HeldCancelApplication, {
      env: "dev",
      processEnv: { HELD_CANCEL_SQLITE_PATH: file },
    });
    opened.push(app);
    const paused = await execute(app, ShortExpiryWorkflowStart, { orderId: "o-3" });
    const [pause] = await app
      .resolve(PausedExecutionRepository)
      .findAllByTenantIdAndRootExecutionId("default", paused.executionId);

    const child = await runScript(file, "reassign", pause?.pauseId ?? "");

    expect(child.stderr).not.toContain("Error");
    expect(child.stdout).toContain("result reassigned=true");
    expect(child.status).toBe(0);
  }, 60_000);
});
