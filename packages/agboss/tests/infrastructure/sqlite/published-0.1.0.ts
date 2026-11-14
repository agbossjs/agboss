import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { runProcess } from "../../helpers/process.js";

/**
 * The published `@agboss/core@0.1.0` as a real writer of a SQLite file (#1035): installed once into
 * a temporary folder (nothing of the repo is touched) and run in a child process, so what writes is
 * 0.1.0's own `SqliteCheckpointSaver` and its own SQL, not a file made to look old.
 */

/** One checkpoint 0.1.0 writes: its id, namespace, thread and the metadata it is given. */
export interface OldPut {
  readonly threadId?: string;
  readonly namespace?: string;
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

let folder = "";

/** Installs 0.1.0 before the tests of the file and removes it after them. */
export function installPublished010(): void {
  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "agboss-0.1.0-"));
    writeFileSync(join(folder, "package.json"), '{"name":"old","private":true,"type":"module"}');
    const installed = await runProcess(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "@agboss/core@0.1.0"],
      { cwd: folder },
    );
    if (installed.status !== 0)
      throw new Error(`npm install @agboss/core@0.1.0: ${installed.stderr}`);
    copyFileSync(
      new URL("./published-0.1.0-writer.mjs", import.meta.url),
      join(folder, "writer.mjs"),
    );
  }, 240_000);
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });
}

/** 0.1.0 puts `puts` into the file at `path`, in order (a failure throws with 0.1.0's message). */
export async function oldPuts(path: string, puts: readonly OldPut[]): Promise<void> {
  const run = await runProcess("node", ["writer.mjs", path, JSON.stringify(puts)], {
    cwd: folder,
  });
  if (run.status !== 0)
    throw new Error(
      `0.1.0 put failed: ${run.stderr.split("\n").find((line) => line.includes("Error")) ?? run.stderr}`,
    );
}
