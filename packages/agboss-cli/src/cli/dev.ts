import { dirname, sep } from "node:path";
import type { CommandLine } from "./studio.js";

/**
 * What `agboss dev` watches and runs (#268 AC6): the application's `src/` (the nearest ancestor of
 * that name, else the application's folder), and per pass the same `agboss` this process runs as —
 * `agboss check` in a short-lived child, which regenerates `.agboss/types.d.ts` and prints the
 * assembly problems it finds.
 */

/** The folder `agboss dev` watches for the application module `file`. */
export function watchedFolderOf(file: string): string {
  const parts = dirname(file).split(sep);
  const at = parts.lastIndexOf("src");
  return at < 0 ? dirname(file) : parts.slice(0, at + 1).join(sep);
}

/** How this process was started: Node's own flags (`--import tsx` from source) and the script. */
export interface CliEntry {
  readonly execArgv: readonly string[];
  readonly script: string;
}

/** What one pass runs: `agboss check --application <file> [--env <name>] [--strict]`. */
export interface PassOptions {
  readonly file: string;
  readonly env: string | undefined;
  readonly strict: boolean;
}

/** The child of one pass: this Node, this CLI, `check` on the application. */
export const checkCommandOf = (entry: CliEntry, pass: PassOptions): CommandLine => ({
  command: process.execPath,
  args: [
    ...entry.execArgv,
    entry.script,
    "check",
    "--application",
    pass.file,
    ...(pass.env === undefined ? [] : ["--env", pass.env]),
    ...(pass.strict ? ["--strict"] : []),
  ],
});
