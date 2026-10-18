import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import { interrupt, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import { resultJudgesFor, runJudges, toolOf } from "./judges.js";
import { callsOf } from "./model-node.js";
import type { LoopStateType, LoopStateUpdate, ToolTask } from "./state.js";
import type {
  ApprovalAnswer,
  ApprovalQuestion,
  JudgeRecord,
  LoopAgent,
  StoredToolResult,
  ToolCallMove,
} from "./types.js";

/** `resume` input is external: parsed at the boundary. */
export const ApprovalAnswerSchema = z.object({
  approved: z.boolean(),
  by: z.string().min(1),
  note: z.string().optional(),
});

/** Calls of the accepted move that still wait for a person. */
export function awaitingApproval(state: LoopStateType, agent: LoopAgent): readonly ToolCallMove[] {
  if (state.move === null) return [];
  return callsOf(state.move).filter(
    (call) =>
      state.decisions[call.callId] === undefined &&
      agent.tools.find((tool) => tool.name === call.tool)?.needsApproval === true,
  );
}

/** Calls allowed to run that have no stored result yet. */
export function runnableCalls(state: LoopStateType): readonly ToolCallMove[] {
  if (state.move === null) return [];
  return callsOf(state.move).filter(
    (call) =>
      state.decisions[call.callId]?.allowed !== false && state.results[call.callId] === undefined,
  );
}

/**
 * Asks about ONE call and pauses (checkpoint = the boundary). Nothing happens before `interrupt`,
 * so re-running this node on resume repeats nothing. One call per pause → one checkpoint per answer.
 */
export function makeApprovalNode(agent: LoopAgent): (state: LoopStateType) => LoopStateUpdate {
  return (state) => {
    const call = awaitingApproval(state, agent)[0];
    if (call === undefined) return {};
    const question: ApprovalQuestion = {
      kind: "tool-approval",
      callId: call.callId,
      tool: call.tool,
      args: call.args,
    };
    const answer: ApprovalAnswer = ApprovalAnswerSchema.parse(interrupt(question));
    const reason = answer.note ?? (answer.approved ? "approved" : "rejected");
    const decision = { callId: call.callId, allowed: answer.approved, by: answer.by, reason };
    return { decisions: { [call.callId]: decision } };
  };
}

/** One tool call = one `Send` task: its result is checkpointed as soon as it finishes. */
export function makeToolNode(
  agent: LoopAgent,
): (task: ToolTask, config: LangGraphRunnableConfig) => Promise<LoopStateUpdate> {
  return async (task, config) => {
    config.writer?.({ kind: "tool-called", ...task });
    const outcome = await toolOf(agent, task.tool).execute(task.args, config.signal);
    const stored: StoredToolResult = { callId: task.callId, tool: task.tool, outcome };
    return { results: { [task.callId]: stored } };
  };
}

function toolMessageFor(state: LoopStateType, call: ToolCallMove): ToolMessage {
  const stored = state.results[call.callId];
  const decision = state.decisions[call.callId];
  const content =
    stored !== undefined
      ? stored.outcome.text
      : `Not run: rejected by ${decision?.by ?? "loop"} — ${decision?.reason ?? "unknown"}`;
  return new ToolMessage({ tool_call_id: call.callId, content });
}

async function afterCallRemark(
  state: LoopStateType,
  agent: LoopAgent,
  calls: readonly ToolCallMove[],
): Promise<{ remark?: string; revisions: Record<string, number>; judgeLog: JudgeRecord[] }> {
  const judgeLog: JudgeRecord[] = [];
  const revisions: Record<string, number> = {};
  for (const call of calls) {
    const stored = state.results[call.callId];
    if (stored?.outcome.kind !== "ok") continue;
    const move = { ...call, kind: "tool-result", result: stored.outcome.text } as const;
    const ledger = {
      used: { ...state.revisions, ...revisions },
      maxPerStep: agent.maxRevisionsPerStep,
    };
    const outcome = await runJudges(
      resultJudgesFor(agent, toolOf(agent, call.tool)),
      move,
      "afterCall",
      ledger,
    );
    Object.assign(revisions, outcome.revisions);
    judgeLog.push(...outcome.records);
    if (outcome.verdict.kind === "revise")
      return { remark: outcome.verdict.remark, revisions, judgeLog };
  }
  return { revisions, judgeLog };
}

/**
 * Fan-in after the parallel tool tasks: tool messages in the MOVE's order (not completion order),
 * then afterCall judges; a revise adds the remark for the next move.
 */
export function makeCollectNode(
  agent: LoopAgent,
): (state: LoopStateType) => Promise<LoopStateUpdate> {
  return async (state) => {
    if (state.move === null) return {};
    const calls = callsOf(state.move);
    const answers = calls.map((call) => toolMessageFor(state, call));
    const { remark, revisions, judgeLog } = await afterCallRemark(state, agent, calls);
    const remarks =
      remark === undefined ? [] : [new HumanMessage(`A reviewer looked at the results: ${remark}`)];
    return { messages: [...answers, ...remarks], move: null, revisions, judgeLog };
  };
}
