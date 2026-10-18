import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./loop-process.ts", import.meta.url));
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spike-114-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Child {
  readonly process: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<number | null>;
}

function launch(args: readonly string[], env: Readonly<Record<string, string>> = {}): Child {
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, dir, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { process: child, output: () => output, exited };
}

async function until(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the child process");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const lines = (file: string): string[] =>
  existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim().split("\n") : [];
const checkpointHas = (text: string): boolean =>
  existsSync(join(dir, "checkpoints.json")) &&
  readFileSync(join(dir, "checkpoints.json"), "utf8").includes(text);

it("survives a kill at the approval pause: a new process resumes, the tool runs once, nothing repeats", async () => {
  const first = launch(["start", "approval"]);
  await until(() => first.output().includes('"kind":"paused"'));
  first.process.kill("SIGKILL");
  await first.exited;

  const second = launch(["resume", "approval"]);
  const code = await second.exited;

  expect(code).toBe(0);
  expect(second.output()).toContain('{"kind":"done","answer":"written"}');
  expect(lines("effects.log")).toEqual(["read a.ts", "write a.ts=new"]);
  expect(lines("model-calls.log")).toEqual(["0", "1", "2"]);
}, 30_000);

it("keeps a finished parallel tool call when the process dies mid-superstep; only the unfinished one reruns", async () => {
  const first = launch(["start", "parallel"], { SLOW_MS: "60000" });
  await until(
    () => lines("effects.log").includes("slow started") && checkpointHas("contents of fast.ts"),
  );
  first.process.kill("SIGKILL");
  await first.exited;

  const second = launch(["recover", "parallel"], { SLOW_MS: "1" });
  const code = await second.exited;

  expect(code).toBe(0);
  expect(second.output()).toContain('{"kind":"done","answer":"both done"}');
  expect(lines("effects.log").sort()).toEqual(
    ["read fast.ts", "slow finished", "slow started", "slow started"].sort(),
  );
  expect(lines("model-calls.log")).toEqual(["0", "1"]);
}, 30_000);
