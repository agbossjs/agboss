import type { Class } from "../components/injection.js";
import { NodeKind } from "./ast.js";
import { declared, recordDeclaration } from "./decorators/declaration.js";
import { agbossComponent } from "./generated-types.js";
import type { ComponentName } from "./registry.js";

/**
 * `ThisWorkflow` (#264): the workflow a flow belongs to, launched as its own child — a recursion of
 * unknown depth, bounded by `@Workflow({ maxDepth })`. It is a marker, written where a child workflow
 * class would be (`.toWorkflow(ThisWorkflow)`, `route(ThisWorkflow)`, `.toParallelWorkflows(ThisWorkflow,
 * …)`) because a decorator's arguments are evaluated before the class exists; the analyser resolves
 * it to the enclosing `@Workflow`. One node of the graph like any class, named `this-workflow`; at
 * run time it is the workflow's own compiled graph, taken from the registry — never a subgraph
 * (a graph cannot contain itself, #263 S37).
 */
export class ThisWorkflow {
  declare readonly [agbossComponent]?: "this-workflow";
}

/** The node `ThisWorkflow` is in every recursive workflow's graph. */
export const THIS_WORKFLOW_NAME = "this-workflow" as ComponentName;

// recorded as a workflow without paths: its node, kind and `name` read like any child's
recordDeclaration(
  ThisWorkflow,
  declared(NodeKind.Workflow, { name: THIS_WORKFLOW_NAME, version: "", flow: [] }, undefined),
);

/** Whether a class is the `ThisWorkflow` marker. */
export const isThisWorkflow = (component: Class): boolean => component === ThisWorkflow;
