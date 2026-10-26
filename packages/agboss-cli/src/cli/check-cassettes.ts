import path from "node:path";
import { cassetteFilesUnder, checkCassettes } from "@agboss/core/internal";
import type { CheckTarget } from "../check.js";
import type { CheckProblem } from "./check-problems.js";

/** The code `agboss check --cassettes` reports a stale cassette with, as a replay throws it. */
const STALE_CASSETTE = "vcr.stale-cassette";

/** A file that looks like a cassette and is not one. */
const UNREADABLE_CASSETTE = "test.cassette-missing";

/**
 * `agboss check --cassettes` (#395 PR 4): every `*.cassette.json` under the project directory
 * compared with the application's components, no test run — a component whose prompt or schema
 * hash changed since it was recorded, or one the application no longer has, is
 * `[vcr.stale-cassette]`; a version 1 cassette (no hashes) is a printed hint, never a problem.
 */
export function cassetteProblems({ context, assembled }: CheckTarget): Promise<CheckProblem[]> {
  const root = context.io.cwd;
  const files = cassetteFilesUnder(root);
  const found = checkCassettes(files, assembled.workflows);
  const shown = (file: string): string => path.relative(root, file) || file;
  found.hints.forEach((hint) => {
    context.say(`hint: ${hint}`);
  });
  context.say(`cassettes: ${String(files.length)} checked`);
  return Promise.resolve([
    ...found.stale.map(({ file, message }) => ({
      file: shown(file),
      code: STALE_CASSETTE,
      message,
    })),
    ...found.unreadable.map(({ file, message }) => ({
      file: shown(file),
      code: UNREADABLE_CASSETTE,
      message,
    })),
  ]);
}
