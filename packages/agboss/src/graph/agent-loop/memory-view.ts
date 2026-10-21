import { SlidingWindowStrategy } from "../../memory/sliding-window.js";
import type { MemoryView } from "../../memory/types.js";
import type { AgentDefinition } from "./deps.js";
import type { AgentLoopStateType } from "./state.js";

const BUILT_IN = new SlidingWindowStrategy();

/** What of the thread memory the agent's model calls see: its strategy's view of the loaded memory. */
export async function memoryViewOf(
  agent: AgentDefinition,
  state: AgentLoopStateType,
): Promise<MemoryView> {
  return (agent.memory ?? BUILT_IN).buildContext({
    agent: agent.name,
    task: state.inputMessage,
    history: state.history,
    summaries: state.summaries,
    limits: { turns: state.history.length, summaries: state.summaries.length },
  });
}
