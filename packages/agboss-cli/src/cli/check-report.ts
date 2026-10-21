import { EnvironmentError } from "agboss";
import {
  describedLimitsOf,
  environmentOwnerOf,
  environmentVariablesOf,
  selectedEnvironment,
  worstCaseLimitsOf,
  worstCaseReportLines,
  worstCaseRowsOf,
  type AssembledApplication,
  type ProcessVariable,
  type WorstCaseRow,
} from "agboss/internal";

/**
 * The report of `agboss check` (#268 AC5) — the same rule as the start log (#261): only what the
 * decorators say, no project code is called (no `maxSpend()`). Per start the worst case of one call,
 * each number with how it is made up; with `--env <name>` the process variables that environment
 * needs, by name, marked `value` / `secret` and optional — never a value. It is the list for
 * `--set-env-vars` / `--set-secrets` at deploy; the names in a secret manager are not known here.
 */

/** One start's worst case as data. */
export interface StartReport {
  readonly start: string;
  readonly workflow: string;
  readonly rows: readonly WorstCaseRow[];
}

/** The environment's process variables as data. */
export interface EnvironmentReport {
  readonly name: string;
  readonly variables: readonly ProcessVariable[];
}

/** What `agboss check` reports besides its problems. */
export interface CheckReport {
  /** `job-scout-application 1.0.0, environment prod`. */
  readonly title: string;
  readonly starts: readonly StartReport[];
  /** With `--env` only. */
  readonly environment?: EnvironmentReport;
  /** The report as printed. */
  readonly lines: readonly string[];
}

/** How a variable is needed: required, with a default, or optional (`env.optional`, #266 S90). */
const presenceLabel = (found: ProcessVariable): string => {
  if (found.optional) return ", optional";
  return found.required ? "" : ", has a default";
};

/** `prod environment needs 3 process variables:`, then one aligned line per variable. */
function environmentLines(report: EnvironmentReport): readonly string[] {
  const { variables } = report;
  const count = variables.length;
  const width = Math.max(0, ...variables.map((found) => found.variable.length));
  return [
    `${report.name} environment needs ${String(count)} process variable${count === 1 ? "" : "s"}${count === 0 ? "" : ":"}`,
    ...variables.map(
      (found) => `  ${found.variable.padEnd(width)}  ${found.use}${presenceLabel(found)}`,
    ),
  ];
}

/**
 * The `--env` environment's variables; none when it cannot be loaded — the environment check
 * reports why (`environment.not-found`, …).
 */
async function environmentReportOf(
  assembled: AssembledApplication,
  envName: string,
): Promise<EnvironmentReport | undefined> {
  try {
    const loaded = await selectedEnvironment(environmentOwnerOf(assembled), envName);
    return loaded === undefined
      ? undefined
      : { name: loaded.name, variables: environmentVariablesOf(loaded) };
  } catch (error) {
    if (error instanceof EnvironmentError) return undefined;
    throw error;
  }
}

/** The environment the report is for: `--env`, else the default of an application that has one. */
const environmentNameOf = (
  assembled: AssembledApplication,
  envName: string | undefined,
): string | undefined =>
  envName ?? (environmentOwnerOf(assembled).contract === undefined ? undefined : "dev");

/** The check report of an assembled application. */
export async function checkReportOf(
  assembled: AssembledApplication,
  envName: string | undefined,
): Promise<CheckReport> {
  const shownEnvironment = environmentNameOf(assembled, envName);
  const title = `${assembled.name} ${assembled.version}${shownEnvironment === undefined ? "" : `, environment ${shownEnvironment}`}`;
  const cases = assembled.workflows.flatMap((workflow) => {
    const limits = describedLimitsOf(workflow);
    return limits.worstCases.map((worst) => ({ worst, limits: worstCaseLimitsOf(limits) }));
  });
  const environment =
    envName === undefined ? undefined : await environmentReportOf(assembled, envName);
  const lines = [
    title,
    ...cases.flatMap(({ worst, limits }) => ["", ...worstCaseReportLines(worst, limits)]),
    ...(environment === undefined ? [] : ["", ...environmentLines(environment)]),
  ];
  return {
    title,
    starts: cases.map(({ worst, limits }) => ({
      start: worst.start,
      workflow: worst.workflow,
      rows: worstCaseRowsOf(worst, limits),
    })),
    ...(environment === undefined ? {} : { environment }),
    lines,
  };
}
