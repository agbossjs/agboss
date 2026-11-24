import { usd, type Milliseconds, type Usd } from "../../units/index.js";
import type { Class } from "../../components/injection.js";
import type { ProfileSelection } from "../../config/profile-names.js";
import { percentile } from "../compare-report.js";
import { compareEvalRuns } from "./compare-runs.js";
import type { EvalRunComparison } from "./comparison.js";
import { runEvalSuiteWith, type RunEvalSuiteOptions } from "./public-run.js";
import type { EvalRunReport, EvalRunResult } from "./report.js";

/**
 * `compareEvalSuite(Application, Suite, { variants })` (#1328d, `@agboss/core/eval`): the suite run
 * once per variant — the application built under that variant's profiles — and every later variant
 * read against the first, case by case, as `--baseline` reads a run against an earlier one.
 */

/** One candidate: a name and the profiles the application is built with. */
export interface EvalComparisonVariant {
  /** Unique in the comparison. */
  readonly name: string;
  readonly profile?: ProfileSelection;
}

/** What a comparison takes: at least two variants, the first the baseline. */
export interface CompareEvalSuiteOptions extends Pick<
  RunEvalSuiteOptions,
  "runs" | "metamorphic" | "tracerProvider" | "processEnv" | "env"
> {
  readonly variants: readonly EvalComparisonVariant[];
}

/** `compareEvalSuite` with the seams of the internal build path replaced (`@agboss/core/internal`). */
type CompareSeams = Parameters<typeof runEvalSuiteWith>[2];

/** One variant's run, with what it cost and how long its runs took. */
export interface EvalVariantReport {
  readonly name: string;
  readonly report: EvalRunReport;
  /** The candidate's own spend over the suite. */
  readonly executionUsd: Usd;
  /** What the judges' calls cost over the suite. */
  readonly judgeUsd: Usd;
  /** The median and the 95th percentile of a run's duration; none when no run kept a trace. */
  readonly latencyP50?: Milliseconds;
  readonly latencyP95?: Milliseconds;
}

/** The variants and how each later one compares with the first. */
export interface EvalSuiteComparison {
  readonly suite: string;
  readonly variants: readonly EvalVariantReport[];
  /** Each variant after the first against the first, in order. */
  readonly comparisons: readonly EvalRunComparison[];
  /** Every variant's execution and judge spend together. */
  readonly totalUsd: Usd;
}

/** How long a run's last execution took: its first step's start to its last step's end. */
function durationOf(result: EvalRunResult): number | undefined {
  const steps = result.trace?.steps ?? [];
  if (steps.length === 0) return undefined;
  const start = Math.min(...steps.map((step) => step.startedAt.getTime()));
  const end = Math.max(...steps.map((step) => step.endedAt.getTime()));
  return end - start;
}

function variantReportOf(name: string, report: EvalRunReport): EvalVariantReport {
  const durations = report.cases
    .flatMap((found) => found.runResults.map(durationOf))
    .filter((found) => found !== undefined);
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  return {
    name,
    report,
    executionUsd: report.spend.executionUsd,
    judgeUsd: report.spend.judgeUsd,
    ...(p50 === null ? {} : { latencyP50: p50 as Milliseconds }),
    ...(p95 === null ? {} : { latencyP95: p95 as Milliseconds }),
  };
}

function checkVariants(variants: readonly EvalComparisonVariant[]): void {
  if (variants.length < 2)
    throw new RangeError("compareEvalSuite: at least two variants — the first is the baseline");
  const repeated = variants.find(
    (variant, index) => variants.findIndex((other) => other.name === variant.name) !== index,
  );
  if (repeated !== undefined)
    throw new RangeError(`compareEvalSuite: two variants are named "${repeated.name}"`);
  const unnamed = variants.find((variant) => variant.name.trim() === "");
  if (unnamed !== undefined) throw new RangeError("compareEvalSuite: a variant needs a name");
}

/** `compareEvalSuite` over the internal build path's seams. */
export async function compareEvalSuiteWith(
  application: Class,
  suite: Class,
  options: CompareEvalSuiteOptions & Pick<NonNullable<CompareSeams>, "seams">,
): Promise<EvalSuiteComparison> {
  const { variants, ...shared } = options;
  checkVariants(variants);
  const reports: EvalVariantReport[] = [];
  for (const variant of variants) {
    const report = await runEvalSuiteWith(application, suite, {
      ...shared,
      profile: variant.profile,
    });
    reports.push(variantReportOf(variant.name, report));
  }
  const [base, ...others] = reports;
  if (base === undefined) throw new RangeError("compareEvalSuite: no variants");
  return {
    suite: base.report.suite,
    variants: reports,
    comparisons: others.map((other) => compareEvalRuns(base.report, other.report, other.name)),
    totalUsd: usd(reports.reduce((sum, found) => sum + found.report.spend.totalUsd, 0)),
  };
}

/** Runs the suite under each variant, one after the other, and reads the later ones against the first. */
export const compareEvalSuite = (
  application: Class,
  suite: Class,
  options: CompareEvalSuiteOptions,
): Promise<EvalSuiteComparison> => compareEvalSuiteWith(application, suite, options);
