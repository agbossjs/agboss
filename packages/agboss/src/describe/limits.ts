import { workflowDeclarationOf } from "../components/module.js";
import { NodeKind } from "../flow/ast.js";
import {
  declaredMaxConcurrentExecutionsOf,
  maxConcurrentExecutionsOf,
} from "../flow/decorators/workflow.js";
import { stepsRangeOf } from "../flow/analyse/steps.js";
import type { WorstCase } from "../flow/analyse/worst-case.js";
import type { AssembledWorkflow } from "../workflow.js";
import { worstCaseReportLines, type WorstCaseLimits } from "./worst-case-report.js";

/**
 * The count limits `agboss describe` shows (#261): `maxSteps` (set, or the default (agents +
 * routers) × 3) with the range of steps an execution takes, each node's `maxVisits`, a recursive
 * workflow's `maxDepth`, for a workflow that launches children its tree's `maxConcurrentExecutions`
 * (#264), and the worst case of one call of each start with how each number is made up (#268, the
 * report of `agboss check`). Money is the application's budgets.
 */

/** The workflow's count limits as data (`describe --json`). */
export interface DescribedLimits {
  readonly maxSteps: number;
  /** Whether `@Workflow({ maxSteps })` sets it (else the default). */
  readonly isMaxStepsSet: boolean;
  readonly steps: { readonly least: number; readonly most: number | undefined };
  /** Each node with `maxVisits`, by node id. */
  readonly maxVisits: Readonly<Record<string, number>>;
  readonly worstCases: readonly WorstCase[];
  /** How many executions of its tree work at once (#264): set, or the default 10. */
  readonly maxConcurrentExecutions: number;
  readonly isMaxConcurrentExecutionsSet: boolean;
  /** `@Workflow({ maxDepth })` of a workflow that launches itself (#264); absent for any other. */
  readonly maxDepth?: number;
}

export function describedLimitsOf(bundle: AssembledWorkflow): DescribedLimits {
  const range = stepsRangeOf(bundle.graph.analysis.graph);
  const visits = [...bundle.graph.nodes.values()].flatMap((node) =>
    node.maxVisits === undefined ? [] : [[node.id, node.maxVisits] as const],
  );
  const maxDepth = bundle.graph.analysis.recursion?.maxDepth;
  return {
    maxSteps: bundle.maxSteps,
    isMaxStepsSet: workflowDeclarationOf(bundle.graph.type).options.maxSteps !== undefined,
    steps: { least: range.least, most: range.most },
    maxVisits: Object.fromEntries(visits),
    worstCases: bundle.graph.analysis.worstCases,
    maxConcurrentExecutions: maxConcurrentExecutionsOf(bundle.graph.type),
    isMaxConcurrentExecutionsSet:
      declaredMaxConcurrentExecutionsOf(bundle.graph.type) !== undefined,
    ...(maxDepth === undefined ? {} : { maxDepth }),
  };
}

/** What the worst-case report of a workflow's starts reads of its limits. */
export const worstCaseLimitsOf = (limits: DescribedLimits): WorstCaseLimits => ({
  maxConcurrentExecutions: limits.maxConcurrentExecutions,
  ...(limits.maxDepth === undefined ? {} : { maxDepth: limits.maxDepth }),
});

/** `maxConcurrentExecutions 6 (set)` — for a workflow that launches children: it has a tree. */
function concurrencyLines(bundle: AssembledWorkflow, limits: DescribedLimits): string[] {
  const hasChildren = [...bundle.graph.nodes.values()].some(
    (node) => node.kind === NodeKind.Workflow,
  );
  if (!hasChildren) return [];
  const source = limits.isMaxConcurrentExecutionsSet ? "set" : "default";
  const cap = String(limits.maxConcurrentExecutions);
  return [`  maxConcurrentExecutions ${cap} (${source}) · executions of the tree at work at once`];
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
  const source = limits.isMaxStepsSet ? "set" : "default: (agents + routers) × 3";
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
