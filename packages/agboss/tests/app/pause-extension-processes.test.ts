/**
 * #1099: two real processes on one SQLite file extend the same pauses at the same instants, one by
 * 30 h and one by 26 h. Whatever the interleaving, no pause ends with a deadline earlier than one a
 * caller was told, a caller told "extended" got a deadline that is on the chain of writes
 * (`previousExpiresAt` is what the store replaced), and the shorter one is refused or comes first.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { outputOf } from "../helpers/process.js";

const SCRIPT = fileURLToPath(new URL("./pause-extension-process.ts", import.meta.url));
const PAUSES = 12;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pause-extension-processes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const node = (...args: readonly string[]) =>
  outputOf(process.execPath, ["--import", "tsx", SCRIPT, join(dir, "app.sqlite"), ...args]);

interface Told {
  readonly pauseId: string;
  readonly ok: boolean;
  readonly expiresAt?: string;
  readonly previousExpiresAt?: string;
  readonly error?: string;
}

/** Starts an extending process, releases both together once both are ready; its lines. */
async function extendTogether(pauseIds: readonly string[]): Promise<readonly (readonly Told[])[]> {
  const children = [30, 26].map((span) =>
    spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        SCRIPT,
        join(dir, "app.sqlite"),
        "extend",
        String(span),
        JSON.stringify(pauseIds),
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    ),
  );
  const ready = new Set<unknown>();
  const outputs = children.map((child) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.startsWith("ready\n") && !ready.has(child)) {
        ready.add(child);
        if (ready.size === children.length) for (const each of children) each.stdin.write("go\n");
      }
    });
    return new Promise<readonly Told[]>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`extend process exited ${String(code)}`));
        const lines = output.trim().split("\n").slice(1);
        resolve(lines.map((line) => JSON.parse(line) as Told));
      });
    });
  });
  return Promise.all(outputs);
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
    const pauseIds = JSON.parse((await node("setup", String(PAUSES))).trim()) as string[];
    expect(pauseIds).toHaveLength(PAUSES);

    const [long, short] = await extendTogether(pauseIds);
    const stored = JSON.parse((await node("dump", JSON.stringify(pauseIds))).trim()) as Record<
      string,
      string
    >;

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
