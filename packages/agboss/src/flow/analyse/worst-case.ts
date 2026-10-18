import { STEPS_PER_WORKING_NODE } from "../../graph/limits.js";
import { NodeKind } from "../ast.js";
import type { ComponentName } from "../registry.js";
import { reachableFrom, type FlowGraph, type FlowLaunch } from "./flow-graph.js";
import { launchLabel } from "./join-groups.js";
import { mostStepsFrom } from "./steps.js";

/**
 * The worst case of one call of each start (#261 start log, #273), from the decorators only: the
 * workflow executions in total and at the same time (one — child workflows come with #263), the
 * agent and router steps — the longest path with every launch at full width (`maxItems` runs of a
 * per-item launch), capped by `maxSteps`, which stops the execution — and how each number is made up.
 */

export interface WorstCase {
  readonly start: ComponentName;
  readonly executions: number;
  readonly concurrentExecutions: number;
  /** Agent and router steps at most. */
  readonly steps: number;
  /** Nesting depth of child workflows: 0 until #263. */
  readonly depth: number;
  /** What the numbers are made of: `maxItems 50 on screening-agent → …`, `maxSteps 12`. */
  readonly parts: readonly string[];
}

/** `maxSteps`, else its default: (agents + routers) × 3. */
export function maxStepsOf(graph: FlowGraph, maxSteps: number | undefined): number {
  if (maxSteps !== undefined) return maxSteps;
  const working = [...graph.nodes.values()].filter(
    (node) => node.kind === NodeKind.Agent || node.kind === NodeKind.Router,
  ).length;
  return working * STEPS_PER_WORKING_NODE;
}

/** The launches an execution from `start` can reach. */
function launchesFrom(graph: FlowGraph, start: ComponentName): readonly FlowLaunch[] {
  const reached = reachableFrom([start], graph.edges);
  const launches = new Set<FlowLaunch>();
  for (const edge of graph.edges)
    if (edge.launch !== undefined && reached.has(edge.from)) launches.add(edge.launch);
  return [...launches];
}

function launchParts(launch: FlowLaunch): readonly string[] {
  const label = launchLabel(launch);
  return [
    ...(launch.maxItems === undefined ? [] : [`maxItems ${String(launch.maxItems)} on ${label}`]),
    ...(launch.maxConcurrency === undefined
      ? []
      : [`maxConcurrency ${String(launch.maxConcurrency)} on ${label}`]),
  ];
}

/** The worst case of one call of `start`. */
function worstCaseFrom(graph: FlowGraph, start: ComponentName, maxSteps: number): WorstCase {
  const most = mostStepsFrom(graph, start);
  const isCapped = most === undefined || most > maxSteps;
  const parts = [
    ...launchesFrom(graph, start).flatMap(launchParts),
    ...(isCapped ? [`maxSteps ${String(maxSteps)}`] : []),
  ];
  return {
    start,
    executions: 1,
    concurrentExecutions: 1,
    steps: isCapped ? maxSteps : most,
    depth: 0,
    parts,
  };
}

/** The worst case of one call of each start of a workflow. */
export function worstCasesOf(graph: FlowGraph, maxSteps: number | undefined): readonly WorstCase[] {
  const limit = maxStepsOf(graph, maxSteps);
  return graph.starts.map((start) => worstCaseFrom(graph, start, limit));
}

/** The start log's line (#261): `Worst case of one x-workflow-start call: 1 workflow execution, …`. */
export function worstCaseLine(worst: WorstCase): string {
  const executions = worst.executions === 1 ? "1 workflow execution" : `${String(worst.executions)} workflow executions`;
  return (
    `Worst case of one ${worst.start} call: ${executions}, ` +
    `${String(worst.concurrentExecutions)} at the same time, ${String(worst.steps)} agent and router steps`
  );
}
