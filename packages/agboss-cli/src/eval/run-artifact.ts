import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvalRunReport } from "agboss/eval";
import { evalRunReportOf } from "agboss/internal";
import type { CommandContext } from "../cli/context.js";
import { CliError } from "../cli/errors.js";

/**
 * A run artifact read back — for `agboss eval show <run.json>` (#397 PR 1) and `agboss eval run
 * --baseline <run.json>` (#396 PR 3): the file read here, validated by the framework's one reader
 * (`evalRunReportOf`, #397 S4) — its `kind`, its `schemaVersion` and every field, the optional
 * `baseline` comparison included.
 */

/** `eval.run-invalid`: the file is not an artifact this version reads, and why. */
export const runArtifactInvalid = (file: string, why: string): CliError =>
  new CliError(
    "usage",
    "eval.run-invalid",
    `${file} is not a run artifact this agboss reads: ${why}`,
  );

/** The artifact at `path` (relative to the working directory), validated. */
export function readRunArtifact(context: CommandContext, path: string): EvalRunReport {
  const file = resolve(context.io.cwd, path);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new CliError("usage", "eval.run-not-found", `no run artifact at ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw runArtifactInvalid(path, "not JSON");
  }
  const read = evalRunReportOf(value);
  if (read.kind === "invalid") throw runArtifactInvalid(path, read.reason);
  return read.report;
}
