import type { AsyncNode } from "../types.js";
import { awaitingApproval } from "./boundary.js";
import { toolNamed } from "./deps.js";
import type { AgentLoopDeps } from "./deps.js";
import type { AgentLoopStateType, AgentLoopUpdate } from "./state.js";
import { JudgePoint, visitToolThenAgent, mergePolicies } from "./judge-points.js";
import { extractRunContext } from "../../core/run-context.js";
import { redactedArguments } from "../../dto/redact.js";
import { inToolCallFrame } from "../../flow/context/frame.js";
import type { AnyTool } from "../../tools/index.js";

/** One sentence on what the call will do (the ask's `summary`), `sensitive` fields masked. */
const summaryOf = (tool: AnyTool, args: Record<string, unknown>): string =>
  `call ${tool.name} with ${JSON.stringify(redactedArguments(tool.input, args))}`;

/**
 * Asks about ONE call — the first that waits — and records the decision by its call id. Nothing
 * happens before the ask, so running this node again on resume repeats nothing; the next waiting
 * call gets its own pause. The ask and the guardrails on the decision run in the call's frame
 * (`executionContext.step.callId`, #280).
 */
export function makeApprovalNode(
  deps: AgentLoopDeps,
): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  const approve = approvalOf(deps);
  return (state, config) => {
    const [call] = awaitingApproval(state, deps);
    const ask = (): Promise<AgentLoopUpdate> => approve(state, config);
    return call === undefined ? ask() : inToolCallFrame(call.callId, {}, ask);
  };
}

// eslint-disable-next-line max-lines-per-function
function approvalOf(deps: AgentLoopDeps): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  return async (state, config) => {
    const runCtx = extractRunContext(config, state.runId);
    const [call] = awaitingApproval(state, deps);
    if (call === undefined || deps.approval === undefined) return {};
    const tool = toolNamed(deps.agent, call.tool);
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
    if (!tool || !tool.channel) return {};

    const decision = await deps.approval.requestApproval(
      {
        callId: call.callId,
        tool: call.tool,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        arguments: call.args as Record<string, unknown>,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        summary: summaryOf(tool, call.args as Record<string, unknown>),
      },
      deps.agent.name,
      tool,
    );
    // what the approver decided goes on as it is: the model boundary masks the feedback (#120)
    const recorded =
      decision.feedback === undefined
        ? {
            approved: decision.approved,
            by: decision.by,
            overrideArguments: decision.overrideArguments,
          }
        : {
            approved: decision.approved,
            by: decision.by,
            feedback: decision.feedback,
            overrideArguments: decision.overrideArguments,
          };
    const combinedGuardrails = mergePolicies(
      deps.workflowGuardrails,
      deps.guardrails,
      deps.toolGuardrails?.(call.tool),
    );
    const ctx = {
      agent: deps.agent.name,
      call,
      runId: runCtx.runId,
    };
    await visitToolThenAgent(
      combinedGuardrails,
      JudgePoint.OnChannelDecision,
      ctx,
      recorded,
      deps.observer,
    );
    return { decisions: { [call.callId]: recorded } };
  };
}
