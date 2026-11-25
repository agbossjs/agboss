import { externalTaskOf } from "../../channels/discovery.js";
import { componentOf } from "../../components/metadata.js";
import type { Class } from "../../components/injection.js";
import { NodeKind } from "../ast.js";
import { declarationOf, type AgentDeclaration } from "../decorators/declaration.js";
import type { ImportTable } from "./imports.js";
import type { AnalysedWorkflow, TypeTable } from "./tables.js";

/**
 * The `AgentTools` table (#679): per agent, the names its model may call — each `@Tool` /
 * and external task (#712) it lists and each tool-mode knowledge base's `search-<rag>-tool` — so a scripted
 * `callTool(…)` / `callTools(…)` turn of another tool does not compile. Each tool and knowledge-base
 * class is branded with its name (`readonly [agbossComponent]?: "order-status-tool"`), what
 * `callTool(Tool, …)` reads.
 */

/**
 * The name a tool, MCP tool, knowledge base or external task (#712) class is known by; `undefined`
 * for any other class.
 */
export function toolComponentNameOf(cls: Class): string | undefined {
  const task = externalTaskOf(cls);
  if (task !== undefined) return task.name;
  const component = componentOf(cls);
  switch (component?.kind) {
    case "tool":
      return component.meta.name;
    default:
      return undefined;
  }
}

/** The tool names of one agent's options, its classes registered for their brands. */
function toolNamesOf(
  options: Pick<AgentDeclaration["options"], "tools">,
  names: ImportTable,
): readonly string[] {
  const tools = (options.tools ?? []).flatMap((cls) => {
    const name = toolComponentNameOf(cls);
    if (name === undefined || names.refIfExported(cls) === undefined) return [];
    return [name];
  });
  return [...new Set(tools)].sort();
}

/** Every agent's entry: the union of its tool names, `never` for an agent without tools. */
export function agentToolsTableOf(
  workflows: readonly AnalysedWorkflow[],
  names: ImportTable,
): TypeTable {
  const table = new Map<string, string>();
  for (const { analysis } of workflows)
    for (const node of analysis.graph.nodes.values()) {
      const { declaration } = node;
      if (declaration.kind !== NodeKind.Agent || table.has(node.name)) continue;
      const tools = toolNamesOf(declaration.options, names);
      table.set(
        node.name,
        tools.length === 0 ? "never" : tools.map((n) => JSON.stringify(n)).join(" | "),
      );
    }
  return table;
}

/** The tools of the agents no workflow reaches (#1324g): a standalone agent's `AgentTools` entry. */
export function standaloneAgentToolsOf(
  components: readonly Class[],
  reached: ReadonlySet<Class>,
  names: ImportTable,
): TypeTable {
  const table = new Map<string, string>();
  for (const component of components) {
    const declaration = declarationOf(component);
    if (reached.has(component) || declaration?.kind !== NodeKind.Agent) continue;
    if (table.has(declaration.options.name)) continue;
    const tools = toolNamesOf(declaration.options, names);
    table.set(
      declaration.options.name,
      tools.length === 0 ? "never" : tools.map((n) => JSON.stringify(n)).join(" | "),
    );
  }
  return table;
}
