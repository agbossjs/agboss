import { requireApplication } from "../application/application.js";
import type { AssembledApplication } from "../application/assemble.js";
import type { Class } from "../components/injection.js";
import { childWorkflowOf } from "../flow/analyse/child-workflow.js";
import { EdgeKind, type FlowEdge, type FlowGraph } from "../flow/analyse/flow-graph.js";
import { startLabel } from "../flow/analyse/rules/children.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * The tree of an application as `agboss describe` shows it (#268 AC4): the workflows it lists,
 * each with its starts and, below it, the child workflows it launches — by which step, one or one
 * per item (`maxItems`, `maxConcurrency`) — down to their own children; `ThisWorkflow` (#264) is the
 * workflow again, marked with its `maxDepth`. Read from the decorators only.
 */

/** How a child is entered from its parent. */
export interface DescribedLaunch {
  /** The steps the edges into it leave, sorted. */
  readonly from: readonly string[];
  readonly isPerItem: boolean;
  readonly maxItems?: number;
  readonly maxConcurrency?: number;
}

/** One workflow of the tree: its name, version, starts and children. */
export interface DescribedWorkflowNode {
  readonly name: string;
  readonly version: string;
  /** `chat-workflow-start (WorkflowStartTextDto)`, a map as `({ a: ADto, b: BDto })`. */
  readonly starts: readonly string[];
  readonly children: readonly DescribedChild[];
}

/** A child of a workflow in the tree. */
export interface DescribedChild {
  readonly launch: DescribedLaunch;
  /** `ThisWorkflow` (#264): the enclosing workflow again, `maxDepth` levels at most. */
  readonly isRecursive: boolean;
  readonly maxDepth?: number;
  /** The child workflow; a recursive one is its parent again and is not expanded. */
  readonly workflow: DescribedWorkflowNode;
}

/** The workflows the application lists, each a tree of its children. */
export interface DescribedTree {
  readonly workflows: readonly DescribedWorkflowNode[];
}

function launchOf(edges: readonly FlowEdge[]): DescribedLaunch {
  const launch = edges.find((edge) => edge.kind === EdgeKind.Launch)?.launch;
  const isPerItem = launch?.items !== undefined;
  return {
    from: [...new Set(edges.map((edge) => edge.from))].sort(),
    isPerItem,
    ...(isPerItem && launch.maxItems !== undefined ? { maxItems: launch.maxItems } : {}),
    ...(isPerItem && launch.maxConcurrency !== undefined
      ? { maxConcurrency: launch.maxConcurrency }
      : {}),
  };
}

const startsOf = (workflow: Class): readonly string[] =>
  (childWorkflowOf(workflow)?.starts ?? []).map(startLabel);

/** Where the tree finds each workflow's assembled graph. */
interface TreeSource {
  readonly graphOf: (workflow: Class) => FlowGraph | undefined;
}

function nodeOf(
  workflow: Class,
  source: TreeSource,
  above: readonly Class[],
): DescribedWorkflowNode {
  const declaration = declarationOf(workflow);
  const options = declaration?.kind === NodeKind.Workflow ? declaration.options : undefined;
  const graph = source.graphOf(workflow);
  const children = [...(graph?.nodes.values() ?? [])].flatMap((node): DescribedChild[] => {
    if (node.kind !== NodeKind.Workflow || graph === undefined) return [];
    const launch = launchOf(graph.edges.filter((edge) => edge.to === node.name));
    if (node.recursionOf !== undefined) {
      const maxDepth = options?.maxDepth;
      return [
        {
          launch,
          isRecursive: true,
          ...(maxDepth === undefined ? {} : { maxDepth }),
          workflow: leafOf(workflow),
        },
      ];
    }
    if (above.includes(node.component)) return [];
    return [
      {
        launch,
        isRecursive: false,
        workflow: nodeOf(node.component, source, [...above, workflow]),
      },
    ];
  });
  return {
    name: options?.name ?? workflow.name,
    version: options?.version ?? "",
    starts: startsOf(workflow),
    children,
  };
}

/** A workflow named in the tree without its children (`ThisWorkflow`: its parent again). */
function leafOf(workflow: Class): DescribedWorkflowNode {
  const declaration = declarationOf(workflow);
  const options = declaration?.kind === NodeKind.Workflow ? declaration.options : undefined;
  return {
    name: options?.name ?? workflow.name,
    version: options?.version ?? "",
    starts: [],
    children: [],
  };
}

/** The application's tree: its listed workflows, each with its children. */
export function describedTreeOf(assembled: AssembledApplication): DescribedTree {
  const byClass = new Map<Class, AssembledWorkflow>(
    assembled.workflows.map((workflow) => [workflow.graph.type, workflow]),
  );
  const source: TreeSource = {
    graphOf: (workflow) => byClass.get(workflow)?.graph.analysis.graph,
  };
  const listed = requireApplication(assembled.application, "agboss describe").options.workflows;
  return { workflows: listed.map((workflow) => nodeOf(workflow, source, [])) };
}

/** `per item from vendor-finder-agent (maxItems 20, maxConcurrency 3)`, `from triage-agent`. */
function launchText(launch: DescribedLaunch): string {
  const limits = [
    ...(launch.maxItems === undefined ? [] : [`maxItems ${String(launch.maxItems)}`]),
    ...(launch.maxConcurrency === undefined
      ? []
      : [`maxConcurrency ${String(launch.maxConcurrency)}`]),
  ];
  const from = `from ${launch.from.join(", ")}`;
  return `${launch.isPerItem ? `per item ${from}` : from}${limits.length === 0 ? "" : ` (${limits.join(", ")})`}`;
}

function childLines(child: DescribedChild, indent: string): string[] {
  const { workflow } = child;
  if (child.isRecursive) {
    const depth = child.maxDepth === undefined ? "" : `, maxDepth ${String(child.maxDepth)}`;
    return [
      `${indent}child ${workflow.name} (ThisWorkflow, recursive${depth}) ${launchText(child.launch)}`,
    ];
  }
  return [
    `${indent}child ${workflow.name} ${workflow.version} ${launchText(child.launch)}`,
    ...nodeLines(workflow, `${indent}  `, false),
  ];
}

function nodeLines(node: DescribedWorkflowNode, indent: string, withTitle: boolean): string[] {
  return [
    ...(withTitle ? [`${indent}${node.name} ${node.version}`] : []),
    ...node.starts.map((start) => `${indent}${withTitle ? "  " : ""}start ${start}`),
    ...node.children.flatMap((child) => childLines(child, `${indent}${withTitle ? "  " : ""}`)),
  ];
}

/** `workflows` — the listed workflows, each with its starts and children, indented. */
export function treeLines(assembled: AssembledApplication): string[] {
  return [
    "workflows",
    ...describedTreeOf(assembled).workflows.flatMap((node) => nodeLines(node, "  ", true)),
  ];
}
