import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixture } from "./agboss.js";

/**
 * `agboss check` loads every module of `src/` for its types: a module that listens to stdin as it
 * is imported (a launcher kept in `src/`) must not keep the process alive once the check is done.
 * Executables belong in `scripts/` or `bin/`, which the check leaves out.
 */

const tsx = createRequire(import.meta.url).resolve("tsx");
const main = new URL("../../src/cli/main.ts", import.meta.url).pathname;

const projects: string[] = [];
afterEach(() => {
  for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("agboss check with a module that attaches to stdin on import", () => {
  it("exits 0 although stdin stays open", async () => {
    const cwd = mkdtempSync(join(dirname(fixture("cli/no-breaker.application.ts")), ".stdin-"));
    projects.push(cwd);
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "p",
        type: "module",
        agboss: { application: "src/app.application.ts" },
      }),
    );
    mkdirSync(join(cwd, "src"));
    writeFileSync(
      join(cwd, "src/app.application.ts"),
      'export { NoBreakerApplication, TestWorkflow } from "../../no-breaker.application.js";\n',
    );
    writeFileSync(
      join(cwd, "src/launcher.ts"),
      'process.stdin.on("data", () => undefined);\nexport const launcher = true;\n',
    );

    const child = spawn(process.execPath, ["--import", tsx, main, "check"], {
      cwd,
      env: { PATH: process.env.PATH, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exit = await new Promise<number | "timeout">((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("timeout");
      }, 15_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
    child.stdin.destroy();

    expect({ exit, output }).toMatchObject({ exit: 0, output: expect.stringContaining("ok:") });
  });
});
