import { workflowDeclarationOf } from "../components/module.js";
import { stepsRangeOf } from "../flow/analyse/steps.js";
import { worstCaseLine, type WorstCase } from "../flow/analyse/worst-case.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * The count limits `agboss describe` shows (#261): `maxSteps` (set, or the default (agents +
 * routers) × 3) with the range of steps an execution takes, each node's `maxVisits`, and the worst
 * case of one call of each start with what it is made of (`maxItems`, `maxConcurrency`,
 * `maxSteps`) — the start log's numbers. Money is the application's budgets.
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
}

export function describedLimitsOf(bundle: AssembledWorkflow): DescribedLimits {
  const range = stepsRangeOf(bundle.graph.analysis.graph);
  const visits = [...bundle.graph.nodes.values()].flatMap((node) =>
    node.maxVisits === undefined ? [] : [[node.id, node.maxVisits] as const],
  );
  return {
    maxSteps: bundle.maxSteps,
    isMaxStepsSet: workflowDeclarationOf(bundle.graph.type).options.maxSteps !== undefined,
    steps: { least: range.least, most: range.most },
    maxVisits: Object.fromEntries(visits),
    worstCases: bundle.graph.analysis.worstCases,
  };
}

/** `Worst case of one x-workflow-start call: … (maxItems 50 on …, maxSteps 12)`. */
const worstLine = (worst: WorstCase): string =>
  `${worstCaseLine(worst)}${worst.parts.length === 0 ? "" : ` (${worst.parts.join(", ")})`}`;

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
    ...limits.worstCases.map((worst) => `  ${worstLine(worst)}`),
  ];
}
