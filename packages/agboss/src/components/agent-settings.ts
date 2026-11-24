import type { AgentsConfigOf } from "../config/types.js";
import type { Class } from "./injection.js";
import { judgeNamesOf } from "./judge-parts.js";
import type { AgentMeta } from "./meta-types.js";
import { OMITTED_MODEL } from "../models/model-cascade.js";
import { modelProviderOf } from "../models/model-provider.decorator.js";
import { windowOfClass, type MemoryOverrides } from "../memory/memory.decorator.js";
import { ragSettings } from "./rag.js";

/** An agent's settings as the config holds them (tools by name). */
export function agentSettings(
  agent: AgentMeta,
  names: ReadonlyMap<Class, string>,
  memoryOverrides?: MemoryOverrides,
): AgentsConfigOf<string>["agents"][string] {
  const optional = {
    thinking: agent.thinking,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    cache: agent.cache,
    uncompactedTurns:
      agent.memory === undefined ? undefined : windowOfClass(agent.memory, memoryOverrides),
    maxModelCalls: agent.maxModelCalls,
    maxToolCalls: agent.maxToolCalls,
    maxRetries: agent.maxRetries,
    price: agent.price,
  };
  const rag = ragSettings(agent);
  const judges = judgeNamesOf(agent);
  return {
    // no model named: the cascade resolves it to its provider's default (#1313)
    model: agent.model ?? OMITTED_MODEL,
    ...(agent.modelProvider === undefined
      ? {}
      : { modelProvider: modelProviderOf(agent.modelProvider).name }),
    description: agent.description,
    ...(judges.length === 0 ? {} : { judges }),
    tools: (agent.tools ?? []).map((cls) => names.get(cls) ?? cls.name),
    ...(rag.length === 0 ? {} : { rag }),
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}
