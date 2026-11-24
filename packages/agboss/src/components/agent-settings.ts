import { RagMode } from "../rag/types.js";
import type { AgentsConfigOf } from "../config/types.js";
import type { Class } from "./injection.js";
import { judgeNamesOf } from "./judge-parts.js";
import type { AgentMeta } from "./meta-types.js";
import { DEFAULT_MODEL_ALIAS } from "../models/model-cascade.js";
import { modelProviderOf } from "../models/model-provider.decorator.js";
import { ragMeta, ragSettings, searchToolName } from "./rag.js";

/** An agent's settings as the config holds them (tools by name). */
export function agentSettings(
  agent: AgentMeta,
  names: ReadonlyMap<Class, string>,
): AgentsConfigOf<string>["agents"][string] {
  const optional = {
    thinking: agent.thinking,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    cache: agent.cache,
    uncompactedTurns: agent.uncompactedTurns,
    maxToolCalls: agent.maxToolCalls,
    maxRetries: agent.maxRetries,
    price: agent.price,
  };
  const search = (agent.rag ?? [])
    .filter((b) => b.mode === RagMode.Tool)
    .map((b) => searchToolName(ragMeta(b.use)));
  const rag = ragSettings(agent);
  const judges = judgeNamesOf(agent);
  return {
    // no model named: the role the provider maps (#1313)
    model: agent.model ?? DEFAULT_MODEL_ALIAS,
    ...(agent.modelProvider === undefined
      ? {}
      : { modelProvider: modelProviderOf(agent.modelProvider).name }),
    description: agent.description,
    ...(judges.length === 0 ? {} : { judges }),
    tools: [...(agent.tools ?? []).map((cls) => names.get(cls) ?? cls.name), ...search],
    ...(rag.length === 0 ? {} : { rag }),
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}
