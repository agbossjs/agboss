import type { Class } from "../components/injection.js";
import type { AgentMeta } from "../components/meta-types.js";
import { componentOf } from "../components/metadata.js";
import { throwIfViolated, violation, type RuleViolation } from "../graph/rule-error.js";

/** The name of a `@Tool` / `@McpTool` class; none for a class of another kind. */
export const toolNameOf = (tool: Class): string | undefined => {
  const component = componentOf(tool);
  return component?.kind === "tool" || component?.kind === "mcp-tool"
    ? component.meta.name
    : undefined;
};

const hasAnyInterceptor = (
  agent: string,
  byAgent: ReadonlyMap<string, ReadonlyMap<string, readonly unknown[]>>,
  ofAgent: ReadonlyMap<string, readonly unknown[]>,
): boolean =>
  (ofAgent.get(agent)?.length ?? 0) > 0 ||
  [...(byAgent.get(agent)?.values() ?? [])].some((chain) => chain.length > 0);

/**
 * Each agent's tool classes by name — per agent, so two agents may call different tools of one
 * name. An agent with tool interceptors that lists a class which is no tool fails the assembly
 * (`[tool-interceptor.unresolved-tool]`): no call it makes may run unintercepted.
 */
export function toolTypesOf(
  agents: readonly AgentMeta[],
  byAgent: ReadonlyMap<string, ReadonlyMap<string, readonly unknown[]>>,
  ofAgent: ReadonlyMap<string, readonly unknown[]>,
): ReadonlyMap<string, ReadonlyMap<string, Class>> {
  const toolTypes = new Map<string, ReadonlyMap<string, Class>>();
  const unresolved: RuleViolation[] = [];
  for (const agent of agents) {
    const types = new Map<string, Class>();
    for (const tool of agent.tools ?? []) {
      const name = toolNameOf(tool);
      if (name !== undefined) types.set(name, tool);
      else if (hasAnyInterceptor(agent.name, byAgent, ofAgent))
        unresolved.push(
          violation(
            "tool-interceptor.unresolved-tool",
            `${agent.name}: ${tool.name || "(anonymous class)"} in tools is not a @Tool / @McpTool class, so its calls cannot be intercepted — an agent with tool interceptors runs no tool they cannot cover`,
            [agent.name],
          ),
        );
    }
    toolTypes.set(agent.name, types);
  }
  throwIfViolated(unresolved);
  return toolTypes;
}
