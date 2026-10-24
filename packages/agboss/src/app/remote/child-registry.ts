import type { Class } from "../../components/injection.js";
import { NodeKind } from "../../flow/ast.js";
import { isThisWorkflow } from "../../flow/this-workflow.js";
import type { GraphDeps } from "../../graph/deps.js";
import type { BuiltApp } from "../create-app.js";

/**
 * Every workflow an instance can run a queued child of (#333 PR 2): the application's workflows
 * and, at any depth, the children they launch — each by its `name`, with its deps (the same an
 * in-process child runs on) and the application workflow of its tree.
 */
export interface ChildRegistry {
  /** The application's workflow by name: a tree's root. */
  readonly rootOf: (name: string) => BuiltApp | undefined;
  /** A workflow's deps by name. */
  readonly depsOf: (name: string) => GraphDeps<string> | undefined;
  /** The `@Workflow` class of a workflow name. */
  readonly workflowOf: (name: string) => Class | undefined;
  /** The class of a node of a workflow, by its id (`critic-agent#2` → `critic-agent`). */
  readonly componentOf: (workflow: string, nodeId: string) => Class | undefined;
}

/** A copy's node id without its copy number. */
const baseNodeId = (nodeId: string): string => nodeId.split("#")[0] ?? nodeId;

export function childRegistryOf(workflows: readonly BuiltApp[]): ChildRegistry {
  const byName = new Map<string, GraphDeps<string>>();
  const visit = (deps: GraphDeps<string>): void => {
    if (byName.has(deps.config.name)) return;
    byName.set(deps.config.name, deps);
    for (const node of deps.graph.nodes.values()) {
      if (node.kind !== NodeKind.Workflow || isThisWorkflow(node.component)) continue;
      const child = deps.childDepsOf?.(node.component);
      if (child !== undefined) visit(child);
    }
  };
  for (const workflow of workflows) visit(workflow.deps);
  const roots = new Map(workflows.map((workflow) => [workflow.deps.config.name, workflow]));
  return {
    rootOf: (name) => roots.get(name),
    depsOf: (name) => byName.get(name),
    workflowOf: (name) => byName.get(name)?.graph.type,
    componentOf: (workflow, nodeId) =>
      byName.get(workflow)?.graph.nodes.get(baseNodeId(nodeId))?.component,
  };
}
