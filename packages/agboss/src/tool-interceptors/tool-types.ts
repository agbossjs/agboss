import type { Class } from "../components/injection.js";
import type { AgentMeta } from "../components/meta-types.js";
import { componentOf } from "../components/metadata.js";
import { throwIfViolated, violation, type RuleViolation } from "../graph/rule-error.js";

/** The name of a `@Tool` class; none for a class of another kind. */
export const toolNameOf = (tool: Class): string | undefined => {
  const component = componentOf(tool);
  return component?.kind === "tool" ? component.meta.name : undefined;
};

const hasAnyInterceptor = (
  agent: string,
  byAgent: ReadonlyMap<string, ReadonlyMap<string, readonly unknown[]>>,
  ofAgent: ReadonlyMap<string, readonly unknown[]>,
): boolean =>
  (ofAgent.get(agent)?.length ?? 0) > 0 ||
  [...(byAgent.get(agent)?.values() ?? [])].some((chain) => chain.length > 0);

/** One agent's tool classes by name, and the rules its list breaks. */
function agentToolTypes(
  agent: AgentMeta,
  intercepted: boolean,
): { types: Map<string, Class>; found: RuleViolation[] } {
  const types = new Map<string, Class>();
  const found: RuleViolation[] = [];
  for (const tool of agent.tools ?? []) {
    const name = toolNameOf(tool);
    const known = name === undefined ? undefined : types.get(name);
    if (name === undefined) {
      if (intercepted)
        found.push(
          violation(
            "tool-interceptor.unresolved-tool",
            `${agent.name}: ${tool.name || "(anonymous class)"} in tools is not a @Tool class, so its calls cannot be intercepted — an agent with tool interceptors runs no tool they cannot cover`,
            [agent.name],
          ),
        );
    } else if (known !== undefined && known !== tool)
      found.push(
        violation(
          "tool-interceptor.duplicate-tool-name",
          `${agent.name}: ${known.name} and ${tool.name} are both named "${name}" — one agent's tools have distinct names, or the wrong class's interceptors would apply`,
          [agent.name],
        ),
      );
    else types.set(name, tool);
  }
  return { types, found };
}

/**
 * Each agent's tool classes by name — per agent, so two agents may call different tools of one
 * name. An agent with tool interceptors that lists a class which is no tool fails the assembly
 * (`[tool-interceptor.unresolved-tool]`); two different classes of one name on one agent fail it too
 * (`[tool-interceptor.duplicate-tool-name]`, ahead of the workflow-wide `[tool.duplicate-name]`, which runs later): no call it makes may run unintercepted.
 */
export function toolTypesOf(
  agents: readonly AgentMeta[],
  byAgent: ReadonlyMap<string, ReadonlyMap<string, readonly unknown[]>>,
  ofAgent: ReadonlyMap<string, readonly unknown[]>,
): ReadonlyMap<string, ReadonlyMap<string, Class>> {
  const toolTypes = new Map<string, ReadonlyMap<string, Class>>();
  const violations: RuleViolation[] = [];
  for (const agent of agents) {
    const { types, found } = agentToolTypes(agent, hasAnyInterceptor(agent.name, byAgent, ofAgent));
    violations.push(...found);
    toolTypes.set(agent.name, types);
  }
  throwIfViolated(violations);
  return toolTypes;
}
