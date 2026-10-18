import { HumanMessage, ToolMessage, type AIMessage } from "@langchain/core/messages";
import { callJudgesFor, runJudges, type RevisionLedger } from "./judges.js";
import { callsOf } from "./model-node.js";
import type { LoopStateType, LoopStateUpdate } from "./state.js";
import type { CallDecision, JudgeRecord, LoopAgent, ToolCallMove } from "./types.js";

const ledgerOf = (state: LoopStateType, agent: LoopAgent): RevisionLedger => ({
  used: state.revisions,
  maxPerStep: agent.maxRevisionsPerStep,
});

/** beforeAnswer: accept → the step's answer; revise → the answer and the remark go back to the model. */
async function reviewAnswer(
  state: LoopStateType,
  agent: LoopAgent,
  move: AIMessage,
): Promise<LoopStateUpdate> {
  const answer = { kind: "answer", text: move.text } as const;
  const outcome = await runJudges(
    agent.judges.beforeAnswer,
    answer,
    "beforeAnswer",
    ledgerOf(state, agent),
  );
  const judgeLog = [...outcome.records];
  if (outcome.verdict.kind === "revise") {
    const remark = new HumanMessage(`A reviewer returned your answer: ${outcome.verdict.remark}`);
    return { messages: [move, remark], move: null, revisions: outcome.revisions, judgeLog };
  }
  return { messages: [move], move: null, answer: move.text, judgeLog };
}

/** Verdicts over all calls of one move; judges see every call, revisions counted across them. */
interface CallsReview {
  readonly revised: ReadonlyMap<string, string>;
  readonly decisions: Record<string, CallDecision>;
  readonly revisions: Record<string, number>;
  readonly judgeLog: JudgeRecord[];
}

async function reviewEachCall(
  state: LoopStateType,
  agent: LoopAgent,
  calls: readonly ToolCallMove[],
): Promise<CallsReview> {
  const revised = new Map<string, string>();
  const review: CallsReview = { revised, decisions: {}, revisions: {}, judgeLog: [] };
  for (const call of calls) {
    const tool = agent.tools.find((candidate) => candidate.name === call.tool);
    if (tool === undefined) {
      const reason = `there is no tool ${call.tool}`;
      review.decisions[call.callId] = { callId: call.callId, allowed: false, by: "loop", reason };
      continue;
    }
    const ledger = {
      used: { ...state.revisions, ...review.revisions },
      maxPerStep: agent.maxRevisionsPerStep,
    };
    const outcome = await runJudges(callJudgesFor(agent, tool), call, "beforeCall", ledger);
    Object.assign(review.revisions, outcome.revisions);
    review.judgeLog.push(...outcome.records);
    if (outcome.verdict.kind === "revise") revised.set(call.callId, outcome.verdict.remark);
    if (outcome.verdict.kind === "reject") {
      const reason = outcome.verdict.reason;
      review.decisions[call.callId] = { callId: call.callId, allowed: false, by: "judge", reason };
    }
  }
  return review;
}

/** A returned move stays in the conversation, every call answered — the provider contract holds. */
function answersToReturnedMove(
  calls: readonly ToolCallMove[],
  revised: CallsReview["revised"],
): ToolMessage[] {
  return calls.map(
    (call) =>
      new ToolMessage({
        tool_call_id: call.callId,
        content:
          revised.get(call.callId) === undefined
            ? "Not run: the move was returned for revision."
            : `Not run, returned for revision: ${revised.get(call.callId) ?? ""}`,
      }),
  );
}

/**
 * The move boundary. A move with calls: any revise returns the WHOLE move (nothing runs, so
 * nothing is repeated when the model redoes it); rejects stop single calls. A move without calls
 * is the answer.
 */
export function makeReviewNode(
  agent: LoopAgent,
): (state: LoopStateType) => Promise<LoopStateUpdate> {
  return async (state) => {
    const move = state.move;
    if (move === null) return {};
    const calls = callsOf(move);
    if (calls.length === 0) return reviewAnswer(state, agent, move);
    const review = await reviewEachCall(state, agent, calls);
    const { decisions, revisions, judgeLog } = review;
    if (review.revised.size > 0) {
      const answered = answersToReturnedMove(calls, review.revised);
      return { messages: [move, ...answered], move: null, revisions, judgeLog };
    }
    return { messages: [move], decisions, revisions, judgeLog };
  };
}
