import { workflowInApplication } from "../application/workflow-application.js";
import type { Class } from "../components/injection.js";
import { childrenFirst } from "../flow/analyse/child-workflow.js";
import type { GraphDeps } from "../graph/deps.js";
import type { AssembledWorkflow } from "../workflow.js";
import { NodeKind } from "../flow/ast.js";
import type { AnyTool } from "../tools/index.js";
import { UnknownToolError } from "./parts.js";

/**
 * The child workflows of a workflow run on its own (#263: eval, replay, Studio): each child is
 * assembled in its application and gets deps of its own on the same infrastructure, so the parent's
 * graph can compile its children; `close()` closes what they opened.
 */

/** The children's deps by class, and how to release them. */
export interface StandaloneChildren {
  readonly childDepsOf: (workflow: Class) => GraphDeps<string> | undefined;
  readonly close: () => Promise<void>;
}

/** What makes one workflow's deps: the same parts for every child. */
export type ChildDepsFactory = (
  bundle: AssembledWorkflow,
  childDepsOf: StandaloneChildren["childDepsOf"],
) => Promise<GraphDeps<string> & { readonly close: () => Promise<void> }>;

/** Every child of `bundle`, each before the workflows that launch it (#336), built with `make`. */
export async function standaloneChildrenOf(
  bundle: AssembledWorkflow,
  make: ChildDepsFactory,
): Promise<StandaloneChildren> {
  const built = new Map<Class, GraphDeps<string> & { readonly close: () => Promise<void> }>();
  const childDepsOf = (workflow: Class): GraphDeps<string> | undefined => built.get(workflow);
  const close = async (): Promise<void> => {
    for (const deps of built.values()) await deps.close();
  };
  try {
    for (const child of childrenFirst([bundle.graph.type]).filter((c) => c !== bundle.graph.type))
      built.set(child, await make(await workflowInApplication(child), childDepsOf));
  } catch (error) {
    await close();
    throw error;
  }
  return { childDepsOf, close };
}

/**
 * A tool of the workflow's tree by name (#263): its own, else one of its children's, at any depth —
 * what a resume validates a decision against when the pause waits inside a child.
 */
export function treeToolsOf(deps: GraphDeps<string>): (name: string) => AnyTool {
  const childrenOf = (of: GraphDeps<string>): readonly GraphDeps<string>[] =>
    [...of.graph.nodes.values()].flatMap((node) => {
      const child = node.kind === NodeKind.Workflow ? of.childDepsOf?.(node.component) : undefined;
      return child === undefined ? [] : [child];
    });
  const find = (of: GraphDeps<string>, name: string, seen: Set<Class>): AnyTool | undefined => {
    if (seen.has(of.graph.type)) return undefined;
    seen.add(of.graph.type);
    try {
      return of.tools(name);
    } catch (error) {
      if (!(error instanceof UnknownToolError)) throw error;
    }
    for (const child of childrenOf(of)) {
      const tool = find(child, name, seen);
      if (tool !== undefined) return tool;
    }
    return undefined;
  };
  return (name) => find(deps, name, new Set()) ?? deps.tools(name);
}
