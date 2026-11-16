import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ApprovalRecord } from "../../pause/index.js";
import { invalidArgumentsMessage, rejectionMessage } from "../../prompts/agents.js";
import { contentWithPieces } from "../../files/file-pieces.js";
import { ModelFileLimitError } from "../../files/file-errors.js";
import { ModelFileLimit } from "../../files/model-files.js";
import { NO_FILES, filePiecesOf, type FileTally } from "../../files/visit-files.js";
import type { AsyncNode } from "../types.js";
import { callsOf, invalidCallsOf, type AgentLoopDeps, type ToolCallRequest } from "./deps.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";
import { stopErrorOf } from "./tool-stops.js";
import { totalCost } from "../../finops/usage.js";
import { meshLimitAt, type MeshLimitPlace } from "../../mesh/mesh-errors.js";
import { meshLimitErrorOf } from "../../mesh/mesh-wire.js";

/** What the model reads for a call: its stored result, or who rejected it and why. */
function contentOf(state: AgentLoopStateType, call: ToolCallRequest): string {
  const stored = state.results[call.callId];
  if (stored !== undefined) return stored.content;
  const decision = state.decisions[call.callId];
  return rejectionMessage(decision?.by ?? "the loop", decision?.reason);
}

/** The decided calls of this move, as the flow keeps them (#100: the turn ends after a decision). */
function decidedCalls(
  state: AgentLoopStateType,
  calls: readonly ToolCallRequest[],
  agent: string,
): ApprovalRecord[] {
  return calls.flatMap((call) => {
    const decision = state.decisions[call.callId];
    if (decision === undefined) return [];
    const result = contentOf(state, call);
    return [
      {
        agent,
        tool: call.tool,
        args: call.args,
        approved: decision.approved,
        by: decision.by,
        result,
      },
    ];
  });
}

/**
 * The first call of the move a tool interceptor stopped (#384), or whose tool met a mesh limit
 * (#398), fails the step, with the loop's spend: a stop as a `StepFailedError`, a mesh limit as
 * itself — at the loop's path, the model never reads it.
 */
function stoppedErrorOf(
  state: AgentLoopStateType,
  calls: readonly ToolCallRequest[],
  agent: string,
): Error | undefined {
  for (const call of calls) {
    const stored = state.results[call.callId];
    const limit = meshLimitErrorOf(stored?.meshLimit);
    if (limit !== undefined) return meshLimitAt(limit, placeOf(state));
    const stop = stored?.stop;
    if (stop === undefined) continue;
    const stopped = { agent, tool: call.tool, callId: call.callId, runId: state.runId };
    return stopErrorOf(stopped, stop, loopUsage(state));
  }
  return undefined;
}

/** Where the loop met a mesh limit: its path, its spend so far and the spend not in state yet. */
const placeOf = (state: AgentLoopStateType): MeshLimitPlace => ({
  path: state.flowPath,
  spentUsd: totalCost(state.usage),
  usage: loopUsage(state),
});

/**
 * The user messages that carry the files of the move's results, and what the conversation then holds
 * of them: over `maxFiles` or `maxTotalFileSize` → `ModelFileLimitError` before the next model call.
 */
async function fileMessagesOf(
  state: AgentLoopStateType,
  calls: readonly ToolCallRequest[],
  deps: AgentLoopDeps,
): Promise<{ readonly messages: readonly HumanMessage[]; readonly tally: FileTally }> {
  const runtime = deps.fileRuntime;
  const settings = runtime?.settings;
  let tally = state.fileTally;
  const messages: HumanMessage[] = [];
  for (const call of calls) {
    const files = state.results[call.callId]?.files;
    if (files === undefined || settings === undefined || runtime === undefined) continue;
    tally = { count: tally.count + files.count, bytes: tally.bytes + files.bytes };
    const agent = deps.agent.name;
    if (tally.count > settings.maxFiles)
      throw new ModelFileLimitError({
        agent,
        limit: ModelFileLimit.MaxFiles,
        actual: tally.count,
        allowed: settings.maxFiles,
      });
    if (tally.bytes > settings.maxTotalFileSize)
      throw new ModelFileLimitError({
        agent,
        limit: ModelFileLimit.MaxTotalFileSize,
        actual: tally.bytes,
        allowed: settings.maxTotalFileSize,
      });
    // read again — the guarded path — and pinned to the digests the tool task saw: the stored call
    // holds references, never bytes
    const built = await filePiecesOf({
      runtime,
      files: files.sources,
      tally: NO_FILES,
      cache: state.fileTranscripts,
      first: 1,
      pins: files.digests,
      beforeModelCall: () => undefined,
    });
    messages.push(new HumanMessage({ content: contentWithPieces("", built.pieces) }));
  }
  return { messages, tally };
}

/**
 * Fan-in after the tool tasks: one tool message per call in the MOVE's order (not completion
 * order), the decisions recorded, the calls' records appended to the visit's trajectory in that
 * order (#395); then the model takes its next turn. A call a tool interceptor stopped fails the
 * step instead (#384).
 */
export function makeCollectNode(
  deps: AgentLoopDeps,
): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  return async (state) => {
    const calls = callsOf(state.move);
    const stopped = stoppedErrorOf(state, calls, deps.agent.name);
    if (stopped !== undefined) throw stopped;
    const unread = invalidCallsOf(state.move);
    const messages: BaseMessage[] = calls.map(
      (call) => new ToolMessage({ tool_call_id: call.callId, content: contentOf(state, call) }),
    );
    // calls whose arguments were no JSON have no place in the move the model is sent back (#395)
    if (unread.length > 0) messages.push(new HumanMessage(invalidArgumentsMessage(unread)));
    // the files of the results follow the tool messages, each call's in a user message (#899 §2)
    const files = await fileMessagesOf(state, calls, deps);
    messages.push(...files.messages);
    const trajectory = [...calls, ...unread].flatMap((call) => {
      const record = state.callRecords[call.callId];
      return record === undefined ? [] : [record];
    });
    return {
      messages,
      move: null,
      approvals: decidedCalls(state, calls, deps.agent.name),
      trajectory,
      ...(files.messages.length === 0 ? {} : { fileTally: files.tally }),
    };
  };
}
