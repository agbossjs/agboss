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
import { writeOutputFile } from "./output-file.js";
import { printRunTable } from "./run-report.js";

/**
 * `agboss eval run [--suite <name>] [--runs <k>] [--report <run.json>] [--html <file>] [--env <name>]`
 * (#396 PR 2): the application built as `createApp` builds it, the suite run on it — every case
 * `--runs` times — its table printed, the artifact written with `--report`, then its HTML report with
 * `--html` (#397 PR 1). The exit code says whether it ran, never
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
    printRunTable(context, report);
    const path = textOption(context.values, "report");
    if (path !== undefined) {
      writeOutputFile(context, path, `${JSON.stringify(report, null, 2)}\n`);
      context.say(`report → ${path}`);
    }
    // the artifact first: a page too large to write leaves the run's artifact written
    const html = textOption(context.values, "html");
    if (html !== undefined)
      await (await import("./html-report.js")).writeHtmlReport(context, html, report);
    const created = [path, html].filter((file) => file !== undefined);
    return {
      result: report,
      ...(created.length === 0 ? {} : { created }),
      warnings: built.app.warnings,
    };
  } finally {
    await built.app.close();
  }
}
