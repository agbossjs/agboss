/**
 * Runs `scripts/check-docs.mjs` (#196) on Markdown files, as `npm run check` does, and keeps what it
 * wrote: the doc snippets as a small project linked to the repo's node_modules (the built package).
 */
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNode, type ProcessRun } from "../helpers/process.js";

export const repo = new URL("../../../../", import.meta.url).pathname;

/** A fresh folder for one check: the docs are written in it, the snippets under `out/`. */
export const scratch = (): string => realpathSync(mkdtempSync(join(tmpdir(), "agboss-docs-")));

/** Writes `docs` (file name → Markdown) into `dir`; returns their paths. */
export function writeDocs(dir: string, docs: Readonly<Record<string, string>>): string[] {
  return Object.entries(docs).map(([name, markdown]) => {
    const path = join(dir, name);
    writeFileSync(path, markdown);
    return path;
  });
}

/** `node scripts/check-docs.mjs --docs … --out <dir>/out`, run from `dir`. */
export function checkDocs(dir: string, docs: readonly string[]): Promise<ProcessRun> {
  const script = join(repo, "scripts/check-docs.mjs");
  const args = ["--docs", docs.join(","), "--out", join(dir, "out"), "--no-cli-sources"];
  return runNode([script, ...args], { cwd: dir });
}

/** `node scripts/check-docs.mjs --wiki <wiki> --out <dir>/out`, run from `dir` (#240). */
export function checkWiki(dir: string, wiki: string): Promise<ProcessRun> {
  const script = join(repo, "scripts/check-docs.mjs");
  const args = ["--wiki", wiki, "--out", join(dir, "out")];
  return runNode([script, ...args], { cwd: dir });
}

/** The environment without this run's Vitest variables, for a Vitest started by a test. */
const cleanEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST"))),
  NO_COLOR: "1",
  FORCE_COLOR: "0",
});

/** Runs Vitest in `dir` (its own vitest.config.ts), as a project that installed agboss would. */
export function runVitest(dir: string): Promise<ProcessRun> {
  const vitest = join(repo, "node_modules/vitest/vitest.mjs");
  return runNode([vitest, "run"], { cwd: dir, env: cleanEnv() });
}
