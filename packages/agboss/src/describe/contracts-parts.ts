import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { flowClassesOf, withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { ContractUse } from "./contracts-types.js";

/** Where `contracts.ts` (#398) finds the workflows that use a consumed contract. */

/** A workflow's name, its node classes and the tools of its agents. */
export interface WorkflowParts {
  readonly name: string;
  readonly nodes: readonly Class[];
  readonly tools: readonly Class[];
}

export function workflowPartsOf(workflows: readonly Class[]): readonly WorkflowParts[] {
  return withChildWorkflows(workflows).flatMap((workflow): WorkflowParts[] => {
    const declaration = declarationOf(workflow);
    if (declaration?.kind !== NodeKind.Workflow) return [];
    const nodes = flowClassesOf(declaration.options.flow);
    const tools = nodes.flatMap((node) => {
      const agent = declarationOf(node);
      return agent?.kind === NodeKind.Agent ? (agent.options.tools ?? []) : [];
    });
    return [{ name: declaration.options.name, nodes, tools: [...new Set(tools)] }];
  });
}

/** Where the application's tools use `client` (a tool that lists it among its `deps`). */
export function usesOf(client: Class, parts: readonly WorkflowParts[]): readonly ContractUse[] {
  return parts.flatMap((part) =>
    part.tools.flatMap((tool) => {
      const meta = componentOf(tool);
      if (meta?.kind !== "tool" && meta?.kind !== "mcp-tool") return [];
      return meta.meta.deps.includes(client) ? [{ workflow: part.name, tool: meta.meta.name }] : [];
    }),
  );
}

/**
 * Where the application's agents reach the MCP `server` (#398 PR 4: the blast radius of each of its
 * tools) — by server, since an `@McpTool` names its server and calls the server's tools in code.
 */
export function mcpUsesOf(server: Class, parts: readonly WorkflowParts[]): readonly ContractUse[] {
  return parts.flatMap((part) =>
    part.tools.flatMap((used) => {
      const meta = componentOf(used);
      if (meta?.kind !== "mcp-tool" || meta.meta.server !== server) return [];
      return [{ workflow: part.name, tool: meta.meta.name }];
    }),
  );
}
