import {
  describedLimitsOf,
  referencedVariablesOf,
  unsetVariablesOf,
  worstCaseLimitsOf,
  worstCaseReportLines,
  worstCaseRowsOf,
  type AssembledApplication,
  type ProcessVariable,
  type WorstCaseRow,
} from "@agboss/core/internal";

/**
 * The report of `agboss check` (#268 AC5) — the same rule as the start log (#261): only what the
 * decorators say, no project code is called (no `maxSpend()`). Per start the worst case of one call,
 * each number with how it is made up; the process variables its `defineEnv` references need, by name, marked `value` / `secret` and optional — never a value. It is the list for
 * `--set-env-vars` / `--set-secrets` at deploy; the names in a secret manager are not known here.
 */

/** One start's worst case as data. */
export interface StartReport {
  readonly start: string;
  readonly workflow: string;
  readonly rows: readonly WorstCaseRow[];
}

/** The process variables the application's components read, as data. */
export interface VariablesReport {
  readonly variables: readonly (ProcessVariable & { readonly isSet: boolean })[];
}

/** What `agboss check` reports besides its problems. */
export interface CheckReport {
  /** `job-scout-application 1.0.0, profiles base+prod`. */
  readonly title: string;
  readonly starts: readonly StartReport[];
  /** The process variables the `defineEnv` references of the application name; absent when none. */
  readonly environment?: VariablesReport;
  /** The report as printed. */
  readonly lines: readonly string[];
}

/** How a variable is needed: required, with a default, or optional (`env.optional`, #266 S90). */
const presenceLabel = (found: VariablesReport["variables"][number]): string => {
  if (found.optional) return ", optional";
  if (found.required) return found.isSet ? "" : ", not set";
  return ", has a default";
};

/** `the application needs 3 process variables:`, then one aligned line per variable. */
function variableLines(report: VariablesReport): readonly string[] {
  const { variables } = report;
  const count = variables.length;
  const width = Math.max(0, ...variables.map((found) => found.variable.length));
  return [
    `the application needs ${String(count)} process variable${count === 1 ? "" : "s"}:`,
    ...variables.map(
      (found) => `  ${found.variable.padEnd(width)}  ${found.use}${presenceLabel(found)}`,
    ),
  ];
}

/** The check report of an assembled application. */
export function checkReportOf(
  assembled: AssembledApplication,
  env: NodeJS.ProcessEnv = {},
): CheckReport {
  const title = `${assembled.name} ${assembled.version}${assembled.profiles.length === 0 ? "" : `, profiles ${assembled.profiles.join("+")}`}`;
  const cases = assembled.workflows.flatMap((workflow) => {
    const limits = describedLimitsOf(workflow);
    return limits.worstCases.map((worst) => ({ worst, limits: worstCaseLimitsOf(limits) }));
  });
  // a variable the selected profile gives through configureEnv is set for the application
  const unset = new Set(unsetVariablesOf(assembled, env).map((found) => found.variable));
  const variables = referencedVariablesOf(assembled).map((found) => ({
    ...found,
    isSet: found.required ? !unset.has(found.variable) : (env[found.variable] ?? "") !== "",
  }));
  const environment = variables.length === 0 ? undefined : { variables };
  const lines = [
    title,
    ...cases.flatMap(({ worst, limits }) => ["", ...worstCaseReportLines(worst, limits)]),
    ...(environment === undefined ? [] : ["", ...variableLines(environment)]),
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
