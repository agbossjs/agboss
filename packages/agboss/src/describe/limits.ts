import { ComponentOptions } from "../components/component-options.js";
import { NodeKind } from "../flow/ast.js";
import { maxConcurrencyUnder } from "../flow/decorators/workflow.js";
import { stepsRangeOf } from "../flow/analyse/steps.js";
import type { WorstCase } from "../flow/analyse/worst-case.js";
import type { AssembledWorkflow } from "../workflow.js";
import { worstCaseReportLines, type WorstCaseLimits } from "./worst-case-report.js";

/**
 * The count limits `agboss describe` shows (#261): `maxSteps` (set, or the default (agents + routers +
 * actions + external tasks) × 3) with the range of steps an execution takes, each node's `maxVisits`, a recursive
 * workflow's `maxDepth`, for a workflow that launches children its tree's `maxConcurrency`
 * (#264), and the worst case of one call of each start with how each number is made up (#268, the
 * report of `agboss check`). Money is the application's budgets.
 */

/** The workflow's count limits as data (`describe --json`). */
export interface DescribedLimits {
  readonly maxSteps: number;
  /** Whether `@Workflow({ executionLimits: { maxSteps } })` sets it (else the default). */
  readonly isMaxStepsSet: boolean;
  readonly steps: { readonly least: number; readonly most: number | undefined };
  /** Each node with `maxVisits`, by node id. */
  readonly maxVisits: Readonly<Record<string, number>>;
  readonly worstCases: readonly WorstCase[];
  /** How many executions of its tree work at once (#264): set, or the default 10. */
  readonly maxConcurrency: number;
  readonly isMaxConcurrencySet: boolean;
  /** `@Workflow({ executionLimits: { maxDepth } })` of a workflow that launches itself (#264); absent for any other. */
  readonly maxDepth?: number;
}

export function describedLimitsOf(bundle: AssembledWorkflow): DescribedLimits {
  const range = stepsRangeOf(bundle.graph.analysis.graph);
  const visits = [...bundle.graph.nodes.values()].flatMap((node) =>
    node.maxVisits === undefined ? [] : [[node.id, node.maxVisits] as const],
  );
  const maxDepth = bundle.graph.analysis.recursion?.maxDepth;
  // the limits as the profiles the workflow was assembled under leave them: what the run enforces
  const { executionLimitsOf: limitsOf } = bundle.componentOptions ?? ComponentOptions.none;
  const own = limitsOf(bundle.graph.type);
  return {
    maxSteps: bundle.maxSteps,
    isMaxStepsSet: own.maxSteps !== undefined,
    steps: { least: range.least, most: range.most },
    maxVisits: Object.fromEntries(visits),
    worstCases: bundle.graph.analysis.worstCases,
    maxConcurrency: maxConcurrencyUnder(limitsOf, bundle.graph.type),
    isMaxConcurrencySet: own.maxConcurrency !== undefined,
    ...(maxDepth === undefined ? {} : { maxDepth }),
  };
}

/** What the worst-case report of a workflow's starts reads of its limits. */
export const worstCaseLimitsOf = (limits: DescribedLimits): WorstCaseLimits => ({
  maxConcurrency: limits.maxConcurrency,
  ...(limits.maxDepth === undefined ? {} : { maxDepth: limits.maxDepth }),
});

/** `maxConcurrency 6 (set)` — for a workflow that launches children: it has a tree. */
function concurrencyLines(bundle: AssembledWorkflow, limits: DescribedLimits): string[] {
  const hasChildren = [...bundle.graph.nodes.values()].some(
    (node) => node.kind === NodeKind.Workflow,
  );
  if (!hasChildren) return [];
  const source = limits.isMaxConcurrencySet ? "set" : "default";
  const cap = String(limits.maxConcurrency);
  return [`  maxConcurrency ${cap} (${source}) · executions of the tree at work at once`];
}

/** `maxDepth 3 (set)` — for a workflow that launches itself (#264). */
const depthLines = (limits: DescribedLimits): string[] =>
  limits.maxDepth === undefined
    ? []
    : [`  maxDepth ${String(limits.maxDepth)} · levels of the workflow launching itself`];

/** The limits section of `describe`'s text. */
export function limitLines(bundle: AssembledWorkflow): string[] {
  const limits = describedLimitsOf(bundle);
  const { least, most } = limits.steps;
  const steps = most === undefined ? `${String(least)}+` : `${String(least)}–${String(most)}`;
  const source = limits.isMaxStepsSet
    ? "set"
    : "default: (agents + routers + actions + external tasks) × 3";
  const visits = Object.entries(limits.maxVisits).map(([node, max]) => `${node} ${String(max)}`);
  return [
    "limits",
    `  maxSteps ${String(limits.maxSteps)} (${source}) · steps ${steps}`,
    ...(visits.length === 0 ? [] : [`  maxVisits ${visits.join(", ")}`]),
    ...depthLines(limits),
    ...concurrencyLines(bundle, limits),
    ...limits.worstCases.flatMap((worst) =>
      worstCaseReportLines(worst, worstCaseLimitsOf(limits)).map((line) => `  ${line}`),
    ),
  ];
}
