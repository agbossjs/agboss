import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startNode } from "../../helpers/process.js";

const SCRIPT = fileURLToPath(new URL("./loop-process.ts", import.meta.url));
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-loop-"));
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
  // the result comes over IPC (#1128): stdout is for logs, never parsed
  const child = startNode(["--import", "tsx", SCRIPT, dir, ...args], {
    env: { ...process.env, ...env },
  });
  return {
    process: child.process,
    output: () =>
      child
        .messages()
        .map((message) => JSON.stringify(message))
        .join("\n"),
    exited: child.exited.then((run) => run.status),
  };
}

async function until(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
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

describe("crash and resume: nothing finished is repeated; a call interrupted by a crash may run again", () => {
  it("AC4: killed (SIGKILL) during a pause and resumed by a new process — finished calls and turns are not repeated, the write runs once", async () => {
    const first = launch(["start", "approval"]);
    await until(() => first.output().includes('"kind":"paused"'));
    first.process.kill("SIGKILL");
    await first.exited;

    const second = launch(["resume", "approval"]);
    const code = await second.exited;

    expect(code).toBe(0);
    expect(second.output()).toContain('{"kind":"answered","reply":"written"}');
    expect(lines("effects.log")).toEqual(["read a.ts", "write a.ts=new"]);
    expect(lines("model-calls.log")).toEqual(["0", "1", "2"]);
  }, 40_000);

  it("AC5: killed while a call runs — the finished parallel call is kept, the interrupted one runs again with the same callId", async () => {
    const first = launch(["start", "parallel"], { SLOW_MS: "60000" });
    await until(
      () =>
        lines("effects.log").includes("slow started slow") && checkpointHas("contents of fast.ts"),
    );
    first.process.kill("SIGKILL");
    await first.exited;

    const second = launch(["recover", "parallel"], { SLOW_MS: "1" });
    const code = await second.exited;

    expect(code).toBe(0);
    expect(second.output()).toContain('{"kind":"answered","reply":"both done"}');
    expect([...lines("effects.log")].sort()).toEqual(
      ["read fast.ts", "slow finished slow", "slow started slow", "slow started slow"].sort(),
    );
    expect(lines("model-calls.log")).toEqual(["0", "1"]);
  }, 40_000);
});
