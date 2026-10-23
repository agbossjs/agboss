import {
  builtApplicationOf,
  compareEvalRuns,
  loadEvalSuites,
  runEvalSuite,
  type ChaosOptions,
  type FoundEvalSuite,
} from "agboss/internal";
import type { Class } from "agboss";
import type { EvalRunReport } from "agboss/eval";
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
import { baselineOf, comparisonLines, regressionFailure } from "./baseline.js";
import { chaosLine, chaosOf } from "./chaos-options.js";
import { printRunTable } from "./run-report.js";

/**
 * `agboss eval run [--suite <name>] [--runs <k>] [--report <run.json>] [--html <file>] [--baseline
 * <run.json> [--fail-on-regression]] [--chaos <rate> --chaos-seed <n> [--chaos-failures <list>]]
 * [--profile <name>] [--env <name>]` (#396 PR 2, PR 3, PR 6 — failures injected into its model calls): the
 * application built as `createApp` builds it, the suite run on it — every case `--runs` times — its
 * table printed, each case against the baseline, the artifact written with `--report`, then its HTML
 * report with `--html` (#397 PR 1). The exit code says whether it ran — and, with
 * `--fail-on-regression`, 5 when a case regressed.
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

/** The application built as `createApp` builds it — with the run's chaos, when it injects some. */
function buildOf(context: CommandContext, application: Class, chaos: ChaosOptions | undefined) {
  return builtApplicationOf(application, {
    ...(chaos === undefined ? {} : { chaos }),
    env: envOption(context),
    profile: textOption(context.values, "profile"),
    processEnv: context.io.env,
    profileRoot: context.io.cwd,
  });
}

/** The artifact with `--report`, then its HTML page with `--html`: the files written. */
async function writtenOf(context: CommandContext, report: EvalRunReport): Promise<string[]> {
  const path = textOption(context.values, "report");
  if (path !== undefined) {
    writeOutputFile(context, path, `${JSON.stringify(report, null, 2)}\n`);
    context.say(`report → ${path}`);
  }
  // the artifact first: a page too large to write leaves the run's artifact written
  const html = textOption(context.values, "html");
  if (html !== undefined)
    await (await import("./html-report.js")).writeHtmlReport(context, html, report);
  return [path, html].filter((file) => file !== undefined);
}

export async function evalRunCommand(context: CommandContext): Promise<CommandOutcome> {
  const runs = runsOf(context);
  const loaded = await loadCliApplication(context);
  const found = suiteOf(context, await loadEvalSuites(loaded.application, loadOptions(context)));
  const baseline = baselineOf(context, found.name);
  const chaos = chaosOf(context);
  const built = await buildOf(context, loaded.application, chaos);
  try {
    const profile = textOption(context.values, "profile");
    const ran = await runEvalSuite(built, found.suite, {
      runs,
      ...(profile === undefined ? {} : { profile }),
      ...(chaos === undefined ? {} : { chaos }),
    });
    printRunTable(context, ran);
    if (ran.chaos !== undefined) context.say(chaosLine(ran.chaos));
    const comparison =
      baseline === undefined ? undefined : compareEvalRuns(baseline.report, ran, baseline.file);
    const report = comparison === undefined ? ran : { ...ran, baseline: comparison };
    if (comparison !== undefined) comparisonLines(comparison).forEach(context.say);
    const created = await writtenOf(context, report);
    const failure = comparison === undefined ? undefined : regressionFailure(context, comparison);
    return {
      result: report,
      ...(created.length === 0 ? {} : { created }),
      warnings: built.app.warnings,
      ...(failure === undefined ? {} : { failure }),
    };
  } finally {
    await built.app.close();
  }
}
