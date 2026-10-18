import { HumanMessage } from "@langchain/core/messages";
import { formatMemory } from "../../flow/runtime/history.js";
import { gatherKnowledge } from "../nodes/knowledge.js";
import type { ApprovalRecord } from "../../pause/index.js";
import type { AsyncNode } from "../types.js";
import type { AgentLoopDeps } from "./deps.js";
import { memoryViewOf } from "./memory-view.js";
import type { AgentLoopStateType, AgentLoopUpdate } from "./state.js";

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/**
 * For an agent visited again in the same execution: its own tool calls decided before, who decided
 * and what the tool returned — so it does not redo a write that is already done.
 */
export function formatDecisionsForAgent(
  approvals: readonly ApprovalRecord[],
  agent: string,
): string {
  const own = approvals.filter((record) => record.agent === agent);
  if (own.length === 0) return "";
  const lines = own.map((record) => {
    const call = `${record.tool} ${clip(JSON.stringify(record.args), 200)}`;
    return record.approved
      ? `- ${call}: approved by ${record.by} and DONE — result: ${clip(record.result ?? "", 300)}`
      : `- ${call}: rejected by ${record.by}, NOT done — ${record.result ?? ""}`;
  });
  return `Your tool calls decided in this execution (already settled — do not repeat them):\n${lines.join("\n")}`;
}

const joined = (parts: readonly string[]): string => parts.filter((p) => p !== "").join("\n\n");

/**
 * The agent's request after its static part (#270 Q51), once per call of the agent (a node of its
 * own, so a resume never retrieves or pays for it again): the thread's memory as one message (it
 * changes rarely — a cache marker can follow it), then the input message with context-mode
 * knowledge and the decisions on its own calls in this execution.
 */
export function makeInputNode(deps: AgentLoopDeps): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  const { agent } = deps;
  return async (state, config) => {
    const knowledge = await gatherKnowledge(
      agent.knowledge,
      state.inputMessage,
      config,
      deps.observer,
    );
    const view = await memoryViewOf(agent, state);
    const memory = formatMemory(view, {
      summaries: view.summaries.length,
      turns: view.history.length,
    });
    const input = joined([
      state.inputMessage,
      knowledge.block.trim(),
      formatDecisionsForAgent(state.approvals, agent.name),
    ]);
    const messages = [
      ...(memory === "" ? [] : [new HumanMessage({ content: memory })]),
      new HumanMessage({ content: input === "" ? "(no input)" : input }),
    ];
    return { messages, usage: knowledge.records };
  };
}
