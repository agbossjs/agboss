import { BaseMemoryStrategy } from "../memory/types.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import { tokenName, type Class } from "./injection.js";
import { ComponentError } from "./metadata.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import { containerFor } from "./runtime.js";

/** The agents with their own memory strategy class. */
const strategiesOf = (
  agents: readonly AgentMeta[],
): (readonly [agent: string, cls: Class<BaseMemoryStrategy>])[] =>
  agents.flatMap((agent) =>
    agent.memoryStrategy === undefined ? [] : [[agent.name, agent.memoryStrategy] as const],
  );

/** Assembly: a `memoryStrategy` must extend `BaseMemoryStrategy` (`@agboss/core/memory`). */
export function checkMemoryStrategies(agents: readonly AgentMeta[]): void {
  for (const [agent, cls] of strategiesOf(agents)) {
    if (!(cls.prototype instanceof BaseMemoryStrategy)) {
      throw new ComponentError(
        `[memory.not-a-strategy] @Agent "${agent}": memoryStrategy ${tokenName(cls)} does not extend BaseMemoryStrategy (agboss/memory)`,
      );
    }
  }
}

/** The agents' memory strategies by agent name, created by the workflow's container. */
export function memoryPartsOf(
  bundle: WorkflowMeta,
  agents: readonly AgentMeta[],
): Pick<AssembledWorkflow, "memoryStrategies"> {
  const strategies = strategiesOf(agents);
  if (strategies.length === 0) return {};
  return {
    memoryStrategies: (services: WorkflowServices) => {
      const container = containerFor(bundle, services);
      return new Map(
        strategies.map(([agent, cls]) => [agent, container.get(cls) as BaseMemoryStrategy]),
      );
    },
  };
}
