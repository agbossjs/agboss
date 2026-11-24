import { createHash } from "node:crypto";
import { sortedJson } from "../../flow/runtime/json.js";
import { Send } from "@langchain/langgraph";
import { approvalChannelOf } from "../../tools/index.js";
import { loopUsage } from "./state.js";
import { invalidArgumentsMessage, unknownToolMessage } from "../../prompts/agents.js";
import { AgentRetryReason, reportAgentRetry } from "./retry-event.js";
import type { AsyncNode } from "../types.js";
import {
  callsOf,
  invalidCallsOf,
  toolNamed,
  type AgentLoopDeps,
  type ToolCallRequest,
} from "./deps.js";
import { unknownToolCallRecordOf, unreadCallRecordOf } from "./call-records.js";
import type { ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import { extractRunContext } from "../../core/run-context.js";
import {
  LOOP_NODE,
  loopProgressOf,
  PreparedFrom,
  type AgentLoopStateType,
  type AgentLoopUpdate,
  type PreparedCall,
  type StoredToolCall,
  type ToolTask,
} from "./state.js";

/** The digest of the arguments the model gave a call. */
export const argsDigestOf = (args: Record<string, unknown>): string =>
  createHash("sha256").update(sortedJson(args)).digest("hex");

/** Whether a prepared call is the call as the model made it: its tool and its arguments. */
export const isPreparedFor = (prepared: PreparedCall, call: ToolCallRequest): boolean =>
  prepared.tool === call.tool && prepared.argsDigest === argsDigestOf(call.args);

/**
 * Calls of the move not prepared yet (#1295c): no input check, PII search and `before` hooks has
 * made them ready, refused or ended — or an approver's override came after the ones that did.
 */
export const unpreparedCalls = (state: AgentLoopStateType): ToolCallRequest[] =>
  callsOf(state.move).filter((call) => {
    if (state.results[call.callId] !== undefined) return false;
    const prepared = state.prepared[call.callId];
    const overridden = state.decisions[call.callId]?.overrideArguments !== undefined;
    // prepared for another tool or other arguments (a call id the model reused): prepared anew
    return (
      prepared === undefined ||
      !isPreparedFor(prepared, call) ||
      (overridden && prepared.from !== PreparedFrom.Approver)
    );
  });

/**
 * Calls of the move that wait for a decision — their tool needs one and nobody decided yet — or for
 * an answer: a question role's call (#712), asked before the move's tools run.
 */
export function awaitingApproval(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
): ToolCallRequest[] {
  const approval = deps.approval;
  if (approval === undefined) return [];
  return callsOf(state.move).filter((call) => {
    const tool = toolNamed(deps.agent, call.tool);
    if (
      tool === undefined ||
      approvalChannelOf(tool) === undefined ||
      state.results[call.callId] !== undefined ||
      // a call that did not pass its checks is never asked about (#1295c)
      state.prepared[call.callId]?.kind !== "ready"
    )
      return false;
    // a question call (#712) waits for its answer, an approval's for its decision
    return tool.question === undefined
      ? state.decisions[call.callId] === undefined
      : state.questionAnswers[call.callId] === undefined;
  });
}

/** Calls of the move allowed to run that have no stored result yet. */
export const runnableCalls = (state: AgentLoopStateType): ToolCallRequest[] =>
  callsOf(state.move).filter(
    (call) =>
      state.results[call.callId] === undefined && state.decisions[call.callId]?.approved !== false,
  );

/** How a call was prepared; every call routed to run was (the prepare node comes first). */
function preparedOf(state: AgentLoopStateType, call: ToolCallRequest): PreparedCall {
  const prepared = state.prepared[call.callId];
  // never run a call nobody checked
  if (prepared === undefined || !isPreparedFor(prepared, call))
    throw new TypeError(`tool call ${call.callId} was not prepared`);
  return prepared;
}

/** A question call's answer for its task (#712); nothing for any other call. */
const answerOf = (
  state: AgentLoopStateType,
  callId: string,
): Pick<ToolTask, "answer" | "invalidAsk"> => {
  const answered = state.questionAnswers[callId];
  if (answered === undefined) return {};
  return answered.problem === undefined
    ? { answer: answered.answer }
    : { invalidAsk: answered.problem };
};

/**
 * After the boundary (and after each decision): ask about the next call that waits (one per pause),
 * else run every allowed call as its own task, else collect the results.
 */
export function routeToActions(
  deps: AgentLoopDeps,
): (state: AgentLoopStateType) => string | Send[] {
  return (state) => {
    if (unpreparedCalls(state).length > 0) return LOOP_NODE.prepare;
    if (awaitingApproval(state, deps).length > 0) return LOOP_NODE.approval;
    const calls = runnableCalls(state);
    if (calls.length === 0) return LOOP_NODE.collect;
    return calls.map(
      (call) =>
        new Send(LOOP_NODE.tool, {
          callId: call.callId,
          tool: call.tool,
          args: preparedOf(state, call).args,
          prepared: preparedOf(state, call),
          runId: state.runId,
          piiKey: state.piiKey,
          piiValues: state.piiValues,
          turn: state.modelCalls,
          progress: loopProgressOf(state),
          fileTally: state.fileTally,
          transcripts: state.fileTranscripts,
          budget: { usage: state.usage, path: state.flowPath, loop: loopUsage(state) },
          ...answerOf(state, call.callId),
        } satisfies ToolTask),
    );
  };
}

/**
 * The move boundary: the move joins the conversation. A call to a tool the agent does not have is
 * answered right here, as a finished call with a tool error.
 */
export function makeBoundaryNode(
  deps: AgentLoopDeps,
): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  return async (state, config) => {
    const at = extractRunContext(config, state.runId).clock.now();
    const results: Record<string, StoredToolCall> = {};
    const unknown: Record<string, ToolCallRecord> = {};
    const site = { agent: deps.agent.name, at };
    for (const call of callsOf(state.move)) {
      if (toolNamed(deps.agent, call.tool) !== undefined) continue;
      const content = unknownToolMessage(call.tool);
      results[call.callId] = { callId: call.callId, tool: call.tool, content };
      // recorded too (#395 S6): the model asked for it
      const progress = loopProgressOf(state);
      unknown[call.callId] = unknownToolCallRecordOf(call, progress, { ...site, content });
    }
    const messages = state.move === null ? [] : [state.move];
    const unread = unreadCallsOf(state, deps, at);
    const callRecords = { ...unknown, ...unread.callRecords };
    const attempted = loopProgressOf(state).validationAttempts;
    for (const [index, call] of invalidCallsOf(state.move).entries()) {
      await reportAgentRetry(deps, {
        reason: AgentRetryReason.InvalidToolInput,
        attempt: attempted + index + 1,
        maxAttempts: deps.agent.limits.modelCalls,
        feedback: invalidArgumentsMessage([call]),
      });
    }
    return { messages, results, ...unread, callRecords };
  };
}

/**
 * The move's calls whose arguments were no JSON (#395): each recorded as `InvalidArguments` and
 * counted as a failed validation of the step; the model reads why after the move's results.
 */
function unreadCallsOf(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  at: Date,
): Pick<AgentLoopUpdate, "callRecords" | "invalidArguments"> {
  const unread = invalidCallsOf(state.move);
  if (unread.length === 0) return {};
  const progress = loopProgressOf(state);
  const site = { agent: deps.agent.name, at };
  const callRecords = Object.fromEntries(
    unread.map((call) => [
      call.callId,
      unreadCallRecordOf(call, toolNamed(deps.agent, call.tool), progress, site),
    ]),
  );
  return { callRecords, invalidArguments: unread.length };
}
