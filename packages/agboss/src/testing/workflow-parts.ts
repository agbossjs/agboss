import type { AssembledApplication } from "../application/assemble.js";
import type { BuiltApplication } from "../application/create-app.js";
import type { Class, Provider } from "../components/injection.js";
import { requireComponent } from "../components/metadata.js";
import { moduleOf } from "../components/module.js";
import { NodeKind } from "../flow/ast.js";
import { isCodeNode } from "../flow/runtime/graph-model.js";
import type { AssembledWorkflow } from "../workflow.js";

/** The MCP server classes of every workflow of the application, and their names. */
export function mcpServersOf(assembled: AssembledApplication): ReadonlyMap<Class, string> {
  return new Map(
    assembled.workflows.flatMap((workflow) =>
      (moduleOf(workflow.graph.type).mcp ?? []).map(
        (cls) => [cls, requireComponent(cls, "mcp-server", "testWith").meta.name] as const,
      ),
    ),
  );
}

const classesOf = (providers: readonly Provider[]): Class[] =>
  providers.filter((provider): provider is Class => !("provide" in provider));

/**
 * Every class a workflow's container may create: providers, the agents' tools and knowledge
 * bases, its actions, finishes and code routers.
 */
function workflowComponentsOf(bundle: AssembledWorkflow): Class[] {
  const providers = classesOf(moduleOf(bundle.graph.type).providers ?? []);
  const nodes = [...bundle.graph.nodes.values()];
  const agents = nodes.flatMap((node) =>
    node.declaration.kind === NodeKind.Agent ? [node.declaration.options] : [],
  );
  const codeNodes = nodes.flatMap((node) =>
    isCodeNode(node) || node.kind === NodeKind.Finish ? [node.component] : [],
  );
  return [
    ...providers,
    ...agents.flatMap((agent) => agent.tools ?? []),
    ...agents.flatMap((agent) => (agent.rag ?? []).map((binding) => binding.use)),
    ...codeNodes,
  ];
}

/** Every class the application's container may create: its own providers and budgets, every workflow's. */
export function usedComponentsOf(assembled: AssembledApplication): ReadonlySet<Class> {
  return new Set<Class>([
    ...assembled.modules.flatMap((module) => classesOf(module.providers)),
    ...assembled.workflows.flatMap(workflowComponentsOf),
  ]);
}

/** The infrastructure instances of an app, by their class: what the next app of the test reuses. */
export const reusedInfrastructure = (built: BuiltApplication): ReadonlyMap<Class, unknown> =>
  new Map(
    Object.values(built.infrastructure).map(
      (instance: object) => [instance.constructor as Class, instance] as const,
    ),
  );
