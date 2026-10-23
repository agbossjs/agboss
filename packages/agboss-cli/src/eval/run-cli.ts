import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  builtApplicationOf,
  loadEvalSuites,
  runEvalSuite,
  type FoundEvalSuite,
} from "agboss/internal";
import { loadCliApplication } from "../cli/cli-application.js";
import {
  loadOptions,
  requiredText,
  textOption,
  type CommandContext,
  type CommandOutcome,
} from "../cli/context.js";
import { envOption } from "../cli/environment.js";
import { CliError, usageError } from "../cli/errors.js";
import { caseLines, headerOf, summaryLine } from "./run-report.js";

/**
 * `agboss eval run [--suite <name>] [--runs <k>] [--report <run.json>] [--env <name>]` (#396 PR 2):
 * the application built as `createApp` builds it, the suite run on it — every case `--runs` times —
 * its table printed, the artifact written with `--report`. The exit code says whether it ran, never
 * how well (`--fail-on-regression` comes with `--baseline`).
 */

const COMMAND = "eval run";

/** `--runs <k>`: a whole number from 1. */
function runsOf(context: CommandContext): number {
  const given = requiredText(context.values, "runs");
  const runs = Number(given);
  if (Number.isInteger(runs) && runs >= 1) return runs;
  throw usageError(
    COMMAND,
    "usage.option-value",
    `option --runs needs a whole number from 1, got "${given}"`,
  );
}

/** The suite `--suite` names — optional when the application has one. */
function suiteOf(context: CommandContext, suites: readonly FoundEvalSuite[]): FoundEvalSuite {
  const given = textOption(context.values, "suite");
  const names = suites.map((found) => found.name).join(", ") || "none";
  if (given === undefined && suites.length === 1 && suites[0] !== undefined) return suites[0];
  const found = suites.find((suite) => suite.name === given);
  if (found !== undefined) return found;
  const what =
    given === undefined
      ? `the application has ${String(suites.length)} eval suites: name one with --suite`
      : `no eval suite named "${given}"`;
  throw new CliError(
    "usage",
    "eval.unknown-suite",
    `${what} — its suites (eval-suites/*.eval-suite.ts): ${names}`,
  );
}

/** Writes the artifact; the path as given, relative to the working directory. */
function writeReport(context: CommandContext, path: string, report: unknown): void {
  const file = resolve(context.io.cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}

export async function evalRunCommand(context: CommandContext): Promise<CommandOutcome> {
  const runs = runsOf(context);
  const loaded = await loadCliApplication(context);
  const found = suiteOf(context, await loadEvalSuites(loaded.application, loadOptions(context)));
  const built = await builtApplicationOf(loaded.application, {
    env: envOption(context),
    processEnv: context.io.env,
    profileRoot: context.io.cwd,
  });
  try {
    const report = await runEvalSuite(built, found.suite, { runs });
    [headerOf(report), ...caseLines(report), summaryLine(report)].forEach(context.say);
    const path = textOption(context.values, "report");
    if (path !== undefined) {
      writeReport(context, path, report);
      context.say(`report → ${path}`);
    }
    const created = path === undefined ? {} : { created: [path] };
    return { result: report, ...created, warnings: built.app.warnings };
  } finally {
    await built.app.close();
  }
}
