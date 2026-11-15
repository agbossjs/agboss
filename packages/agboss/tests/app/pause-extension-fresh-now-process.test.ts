/**
 * #1148 on a real process, a real clock and a real SQLite file: a pause with a 2 s deadline is extended by
 * working time through a calendar that really takes 3 s. The deadline passes inside the calendar (the expiry
 * handler is entered), so the extension is refused with `PauseClosedError` and the stored deadline is unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNodeReporting } from "../helpers/process.js";

const SCRIPT = fileURLToPath(new URL("./pause-extension-fresh-now-process.ts", import.meta.url));
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pause-extension-fresh-now-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("#1148: a real calendar that outlives the deadline", () => {
  it("the extension is refused, the stored deadline is the one the pause had", async () => {
    const run = await runNodeReporting(["--import", "tsx", SCRIPT, join(dir, "app.sqlite")]);
    if (run.status !== 0)
      throw new Error(`the script failed (${String(run.status)}):\n${run.stderr}`);

    const told = run.messages[0] as {
      deadline: string;
      nowAtAnswer: string;
      outcome: { ok: boolean; error?: string };
      storedExpiresAt: string;
    };
    expect(told.nowAtAnswer > told.deadline).toBe(true);
    expect(told.outcome).toEqual({ ok: false, error: "PauseClosedError" });
    expect(told.storedExpiresAt).toBe(told.deadline);
  }, 60_000);
});
