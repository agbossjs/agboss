/**
 * #1099, #1307: two real processes on one SQLite file change the timeout of the same pauses at the
 * same instants, one to 30 h and one to 26 h. Whatever the interleaving, both are told, and what
 * each was told is one chain of writes: the one that landed second names the deadline of the one that
 * landed first as `previousExpiresAt` (the store replaced exactly that), and the stored deadline is
 * the second one's — a deadline may shorten, but never one the chain does not show.
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

/** Starts two processes changing the timeout, releases both together once both are ready; what each told. */
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

/** The two writes are one chain: the later names the earlier's deadline, and the later one is stored. */
function expectOnChain(long: Told | undefined, short: Told | undefined, stored: string): void {
  expect(long?.ok).toBe(true);
  expect(short?.ok).toBe(true);
  const isLongFirst = short?.previousExpiresAt === long?.expiresAt;
  const [first, second] = isLongFirst ? [long, short] : [short, long];
  expect(second?.previousExpiresAt).toBe(first?.expiresAt);
  expect(stored).toBe(second?.expiresAt);
}

describe("#1099: two processes change the timeout of the same pauses at once", () => {
  it("AC1: the stored deadline is the last write for every pause, and every told deadline is on the chain", async () => {
    const pauseIds = (await node("setup", String(PAUSES))) as string[];
    expect(pauseIds).toHaveLength(PAUSES);

    const [long, short] = await extendTogether(pauseIds);
    const stored = (await node("dump", JSON.stringify(pauseIds))) as Record<string, string>;

    for (const pauseId of pauseIds) {
      const longTold = long?.find((one) => one.pauseId === pauseId);
      const shortTold = short?.find((one) => one.pauseId === pauseId);
      expectOnChain(longTold, shortTold, stored[pauseId] ?? "");
    }
  }, 120_000);
});
