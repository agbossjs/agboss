import type { WorstCase, WorstCaseChild } from "../flow/analyse/worst-case.js";

/**
 * The worst case of one call of a start, as `agboss check` and `agboss describe` print it (#268
 * AC5): four numbers, each with how it is made up — from the decorators only, no project code runs.
 *
 * ```
 * Worst case of one screening-workflow-start call
 *   workflow executions     51   1 screening-workflow + 50 company-check-workflow (maxItems 50)
 *   at the same time        5    1 screening-workflow + 4 company-check-workflow (maxConcurrency 4)
 *   agent and router steps  512  12 in screening-workflow (maxSteps) + 50 × 10 in company-check-workflow (maxSteps)
 *   nesting depth           2    screening-workflow → company-check-workflow
 * ```
 */

/** What a row counts. */
export enum WorstCaseMeasure {
  Executions = "workflow executions",
  ConcurrentExecutions = "at the same time",
  Steps = "agent and router steps",
  Depth = "nesting depth",
}

/** One row of the report: what it counts, the number, and how the number is made up. */
export interface WorstCaseRow {
  readonly measure: WorstCaseMeasure;
  readonly total: number;
  readonly madeUp: string;
}

/** One workflow's share of a number: how many of it, and the limits along the way that say so. */
interface Share {
  readonly workflow: string;
  readonly multiplier: number;
  readonly limits: readonly string[];
  readonly worst: WorstCase;
}

const limitsText = (limits: readonly string[]): string =>
  limits.length === 0 ? "" : ` (${limits.join(" × ")})`;

/** `maxItems 50` for a per-item launch; nothing for one child. */
const countLimit = (child: WorstCaseChild): readonly string[] =>
  child.maxItems === undefined ? [] : [`maxItems ${String(child.maxItems)}`];

/** What bounds how many children of an edge run at once: `maxConcurrency`, else `maxItems`. */
function atOnceLimit(child: WorstCaseChild): readonly string[] {
  if (child.maxConcurrency !== undefined && child.maxConcurrency < child.count)
    return [`maxConcurrency ${String(child.maxConcurrency)}`];
  return countLimit(child);
}

/** Every execution of the tree: the call itself, then each child edge's, depth first. */
function executionShares(
  worst: WorstCase,
  multiplier = 1,
  limits: readonly string[] = [],
): Share[] {
  return [
    { workflow: worst.workflow, multiplier, limits, worst },
    ...worst.children.flatMap((child) =>
      executionShares(child.worst, multiplier * child.count, [...limits, ...countLimit(child)]),
    ),
  ];
}

/** The child edge with the most executions at once: the one the number is made of. */
const widestChild = (worst: WorstCase): WorstCaseChild | undefined =>
  worst.children.reduce<WorstCaseChild | undefined>(
    (widest, child) =>
      widest === undefined ||
      child.atOnce * child.worst.concurrentExecutions >
        widest.atOnce * widest.worst.concurrentExecutions
        ? child
        : widest,
    undefined,
  );

/** The executions at the same time: the call itself, then the widest child edge's, depth first. */
function concurrentShares(
  worst: WorstCase,
  multiplier = 1,
  limits: readonly string[] = [],
): Share[] {
  const widest = widestChild(worst);
  return [
    { workflow: worst.workflow, multiplier, limits, worst },
    ...(widest === undefined
      ? []
      : concurrentShares(widest.worst, multiplier * widest.atOnce, [
          ...limits,
          ...atOnceLimit(widest),
        ])),
  ];
}

/** The deepest chain of child edges below the call. */
function deepestChain(worst: WorstCase): readonly WorstCaseChild[] {
  const deepest = worst.children.find((child) => child.worst.depth + 1 === worst.depth);
  return deepest === undefined ? [] : [deepest, ...deepestChain(deepest.worst)];
}

const sharesText = (shares: readonly Share[]): string =>
  shares
    .map((share) => `${String(share.multiplier)} ${share.workflow}${limitsText(share.limits)}`)
    .join(" + ");

/** `12 in screening-workflow (maxSteps)`, `50 × 10 in company-check-workflow (longest path)`. */
function stepsText(shares: readonly Share[]): string {
  return shares
    .map((share) => {
      const per = String(share.worst.steps);
      const times = share.multiplier === 1 ? per : `${String(share.multiplier)} × ${per}`;
      const bound = share.worst.isStepsCapped ? "maxSteps" : "longest path";
      return `${times} in ${share.workflow} (${bound})`;
    })
    .join(" + ");
}

/** `screening-workflow → company-check-workflow`, `(maxDepth 3)` when a level is the workflow again. */
function depthText(worst: WorstCase, maxDepth: number | undefined): string {
  const chain = deepestChain(worst);
  const names = [worst.workflow, ...chain.map((child) => child.worst.workflow)].join(" → ");
  const isRecursive = chain.some((child) => child.isRecursive);
  return isRecursive && maxDepth !== undefined ? `${names} (maxDepth ${String(maxDepth)})` : names;
}

/** What the root workflow's limits add to the report. */
export interface WorstCaseLimits {
  /** `@Workflow({ maxConcurrentExecutions })` of the root: how many of the tree work at once (#264). */
  readonly maxConcurrentExecutions: number;
  /** `@Workflow({ maxDepth })` of a recursive root. */
  readonly maxDepth?: number;
}

/** `— at most 4 at work at once (maxConcurrentExecutions 4)` when the tree's cap is lower. */
const atWorkText = (worst: WorstCase, limits: WorstCaseLimits): string =>
  worst.children.length > 0 && limits.maxConcurrentExecutions < worst.concurrentExecutions
    ? ` — at most ${String(limits.maxConcurrentExecutions)} at work at once (maxConcurrentExecutions ${String(limits.maxConcurrentExecutions)})`
    : "";

/** The four rows of one start's worst case. */
export function worstCaseRowsOf(
  worst: WorstCase,
  limits: WorstCaseLimits,
): readonly WorstCaseRow[] {
  const executions = executionShares(worst);
  return [
    {
      measure: WorstCaseMeasure.Executions,
      total: worst.executions,
      madeUp: sharesText(executions),
    },
    {
      measure: WorstCaseMeasure.ConcurrentExecutions,
      total: worst.concurrentExecutions,
      madeUp: `${sharesText(concurrentShares(worst))}${atWorkText(worst, limits)}`,
    },
    { measure: WorstCaseMeasure.Steps, total: worst.treeSteps, madeUp: stepsText(executions) },
    {
      measure: WorstCaseMeasure.Depth,
      total: worst.depth + 1,
      madeUp: depthText(worst, limits.maxDepth),
    },
  ];
}

const MEASURE_WIDTH = Math.max(...Object.values(WorstCaseMeasure).map((measure) => measure.length));

/** The report of one start: its title, then one aligned row per number. */
export function worstCaseReportLines(worst: WorstCase, limits: WorstCaseLimits): readonly string[] {
  const rows = worstCaseRowsOf(worst, limits);
  const width = Math.max(...rows.map((row) => String(row.total).length));
  return [
    `Worst case of one ${worst.start} call`,
    ...rows.map(
      (row) =>
        `  ${row.measure.padEnd(MEASURE_WIDTH)}  ${String(row.total).padEnd(width)}  ${row.madeUp}`,
    ),
  ];
}
