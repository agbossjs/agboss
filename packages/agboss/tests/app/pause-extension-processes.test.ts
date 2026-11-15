/**
 * #1099: two real processes on one SQLite file extend the same pauses at the same instants, one by
 * 30 h and one by 26 h. Whatever the interleaving, no pause ends with a deadline earlier than one a
 * caller was told, a caller told "extended" got a deadline that is on the chain of writes
 * (`previousExpiresAt` is what the store replaced), and the shorter one is refused or comes first.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runNodeReporting, startNode } from "../helpers/process.js";

const SCRIPT = fileURLToPath(new URL("./pause-extension-process.ts", import.meta.url));
const PAUSES = 12;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pause-extension-processes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One run of the script to its end: the one message it reports (IPC, #1128 — stdout is only logs). */
async function node(...args: readonly string[]): Promise<unknown> {
  const run = await runNodeReporting(["--import", "tsx", SCRIPT, join(dir, "app.sqlite"), ...args]);
  if (run.status !== 0)
    throw new Error(`the script failed (${String(run.status)}):\n${run.stderr}`);
  return run.messages[0];
}

interface Told {
  readonly pauseId: string;
  readonly ok: boolean;
  readonly expiresAt?: string;
  readonly previousExpiresAt?: string;
  readonly error?: string;
}

/** Starts two extending processes, releases both together once both are ready; what each told. */
async function extendTogether(pauseIds: readonly string[]): Promise<readonly (readonly Told[])[]> {
  const children = [30, 26].map((span) =>
    startNode([
      ...["--import", "tsx", SCRIPT, join(dir, "app.sqlite")],
      ...["extend", String(span), JSON.stringify(pauseIds)],
    ]),
  );
  await Promise.all(children.map((child) => child.waitFor((message) => message === "ready")));
  for (const child of children) child.send("go");
  return Promise.all(
    children.map(async (child) => {
      const run = await child.exited;
      if (run.status !== 0)
        throw new Error(`extend process exited ${String(run.status)}:\n${run.stderr}`);
      return child.messages().filter((message) => message !== "ready") as Told[];
    }),
  );
}

/** The shorter extension either went first (the long one moved from its deadline) or was refused. */
function expectOnChain(long: Told | undefined, short: Told | undefined): void {
  if (short?.ok !== true) {
    expect(short).toMatchObject({ ok: false, error: "DtoValidationError" });
    return;
  }
  expect(long?.previousExpiresAt).toBe(short.expiresAt);
  expect((short.expiresAt ?? "") < (long?.expiresAt ?? "")).toBe(true);
}

describe("#1099: two processes extend the same pauses at once", () => {
  it("AC1: the stored deadline is the longer one for every pause, and every told deadline is on the chain", async () => {
    const pauseIds = (await node("setup", String(PAUSES))) as string[];
    expect(pauseIds).toHaveLength(PAUSES);

    const [long, short] = await extendTogether(pauseIds);
    const stored = (await node("dump", JSON.stringify(pauseIds))) as Record<string, string>;

    for (const pauseId of pauseIds) {
      const longTold = long?.find((one) => one.pauseId === pauseId);
      const shortTold = short?.find((one) => one.pauseId === pauseId);
      // the 30 h extension is always later than the 26 h one: it is never refused for a shorter deadline
      expect(longTold?.ok).toBe(true);
      expect(stored[pauseId]).toBe(longTold?.expiresAt);
      expectOnChain(longTold, shortTold);
    }
  }, 120_000);
});
