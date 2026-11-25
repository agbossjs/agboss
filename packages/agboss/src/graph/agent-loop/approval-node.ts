import { ValidationError } from "../../core/error-families/effect-errors.js";
import { WorkingCalendarError } from "../../calendar/working-calendar.js";
import type { AsyncNode } from "../types.js";
import { awaitingApproval } from "./boundary.js";
import { toolNamed } from "./deps.js";
import type { AgentLoopDeps } from "./deps.js";
import { callStepOf, declinedCallRecordOf } from "./call-records.js";
import { toolRecordOf } from "../../flow/runtime/tool-keys.js";
import { extractRunContext } from "../../core/run-context.js";
import {
  loopProgressOf,
  loopUsage,
  type AgentLoopStateType,
  type AgentLoopUpdate,
  type CallDecision,
} from "./state.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import { countBoundOf } from "../count-limit.js";
import { totalCost } from "../../finops/usage.js";
import { currentFrame } from "../../flow/context/frame.js";
import { VisitsLimitExceededError } from "../../flow/runtime/errors.js";
import { ChannelSendError } from "../../flow/runtime/pause.js";
import { expiryFailureOf, PauseExpirySignal } from "../../flow/runtime/pause-expiry-failure.js";
import { ComponentKind } from "../../flow/runtime/records.js";
import { AgentFailedError } from "../errors.js";
import type { ToolCallApproval } from "./approval.js";
import type { ToolCallRequest } from "./deps.js";
import { redactedArguments } from "../../dto/redact.js";
import { inToolCallFrame } from "../../flow/context/frame.js";
import type { AnyTool } from "../../tools/index.js";

/** The call's arguments as an approver may see them: kept by its preparing, never made again. */
function shownOf(state: AgentLoopStateType, call: ToolCallRequest): Record<string, unknown> {
  const prepared = state.prepared[call.callId];
  // an ask is made only for a call that passed its checks
  if (prepared?.kind !== "ready") throw new TypeError(`tool call ${call.callId} is not ready`);
  return { ...prepared.shown };
}

/** One sentence on what the call will do (the ask's `summary`), `sensitive` fields masked. */
const summaryOf = (tool: AnyTool, args: Record<string, unknown>): string =>
  `call ${tool.name} with ${JSON.stringify(redactedArguments(tool.input, args))}`;

/**
 * Asks about ONE call — the first that waits — and records the decision by its call id. Nothing
 * happens before the ask, so running this node again on resume repeats nothing; the next waiting
 * call gets its own pause. The ask runs in the call's frame
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

function approvalOf(deps: AgentLoopDeps): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  return async (state, config) => {
    const [call] = awaitingApproval(state, deps);
    const { approval } = deps;
    if (call === undefined || approval === undefined) return {};
    const tool = toolNamed(deps.agent, call.tool);
    if (tool?.approval === undefined) return {};
    // what the call became before this ask (#1295c): the approver sees its arguments masked
    const shown = shownOf(state, call);
    if (tool.question !== undefined)
      return askQuestion(state, deps, { call, tool, approval, shown }, config);

    const decision = await askedOrFailed(state, deps, () =>
      approval.requestApproval(
        {
          callId: call.callId,
          tool: call.tool,
          arguments: shown,
          summary: summaryOf(tool, shown),
        },
        deps.agent.name,
        tool,
        config?.signal,
      ),
    );
    // what the approver decided goes on as it is: the model boundary masks the reason (#120)
    const recorded: CallDecision = {
      approved: decision.approved,
      by: decision.by,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      ...(decision.overrideInput === undefined ? {} : { overrideInput: decision.overrideInput }),
    };
    // a free-text reply's interpreter calls are the loop's spend from now on (#267 PR 3)
    const update = { decisions: { [call.callId]: recorded }, usage: [...decision.usage] };
    if (decision.approved) return update;
    // a declined call never runs: its record is made here (#395)
    const step = callStepOf(
      toolRecordOf(tool),
      call.callId,
      loopProgressOf(state),
      deps.agent.name,
    );
    const at = extractRunContext(config, state.runId).clock.now();
    return { ...update, callRecords: { [call.callId]: declinedCallRecordOf(step, call.args, at) } };
  };
}

/**
 * A question role an agent asks through its tool loop (#712), at the loop's approval step — before
 * the move's tools run, one call per pause, in the move's order. Before the ask: the role's
 * `maxVisits` (how many of its calls one visit may ask; the next one fails the step with
 * `VisitsLimitExceededError`), the execution's budgets (an exhausted one asks nobody) and the
 * holder's fence (a holder past its lease asks nobody: a hand-over). The ask is the pause seam's:
 * its record made by the call's step key before `send`, so the re-entry on resume finds the answer
 * and asks nothing again. The answer, validated as the role's `answer`, is kept by call id: the
 * call's task gives it as its result.
 */

/** The failure of the agent whose approval or question call's pause expired (#941, D6, D8). */
const expiryOf = (
  signal: PauseExpirySignal,
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
): Error =>
  expiryFailureOf(signal.pause, {
    step: deps.agent.name,
    stepKind: ComponentKind.Agent,
    state: state.usage,
    usage: loopUsage(state),
    path: state.flowPath,
    budgets: deps.budgets,
  });

/**
 * The ask's decision; a channel that failed fails the agent's step (its error as `cause`) — and,
 * for a question (#712), an answer its channel decided at once that is no valid answer (an
 * approval's invalid decision rises as it is, #267 AC7).
 */
async function askedOrFailed<TAnswer>(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  ask: () => Promise<TAnswer>,
  isQuestion = false,
): Promise<TAnswer> {
  try {
    return await ask();
  } catch (error) {
    // a calendar that could not answer (#944): nobody was asked, the agent's step fails
    const isCalendar = error instanceof WorkingCalendarError;
    if ((isQuestion && error instanceof ValidationError.DtoInvalid) || isCalendar)
      throw new AgentFailedError({ agent: deps.agent.name, usage: loopUsage(state), cause: error });
    // its pause's deadline passed (#941): the whole agent step fails, its spend kept
    if (error instanceof PauseExpirySignal) throw expiryOf(error, state, deps);
    if (!(error instanceof ChannelSendError)) throw error;
    throw new AgentFailedError({
      agent: deps.agent.name,
      usage: loopUsage(state),
      cause: error.cause,
    });
  }
}

/** The question call to ask and how it is asked. */
interface QuestionCall {
  readonly call: ToolCallRequest;
  readonly tool: AnyTool;
  readonly approval: ToolCallApproval;
  /** The question's arguments as prepared: valid as the role's ask, masked. */
  readonly shown: Record<string, unknown>;
}

/** How many of the role's calls this visit asked already. */
const askedOf = (state: AgentLoopStateType, tool: AnyTool): number =>
  Object.values(state.questionAnswers).filter((answered) => answered.tool === tool.name).length;

/** The checks before a question is asked: its `maxVisits`, the budgets, the holder's fence. */
function checkBeforeAsking(state: AgentLoopStateType, deps: AgentLoopDeps, tool: AnyTool): void {
  // Stryker disable next-line OptionalChaining: only a question role's call is checked here, and a question role has its `question`
  const maxVisits = tool.question?.maxVisits;
  const spent = totalCost(state.usage);
  // a limit that is no count is a bound of 0, as in the flow's own guard (#1373)
  if (maxVisits !== undefined && askedOf(state, tool) >= countBoundOf(maxVisits))
    throw new VisitsLimitExceededError({
      component: toolRecordOf(tool),
      maxVisits: countBoundOf(maxVisits),
      path: state.flowPath,
      spentUsd: spent,
    });
  deps.budgets.check(state.usage, state.flowPath, loopUsage(state));
  currentFrame()?.execution.lease?.assertHeld();
}

/** Asks one question call and keeps its answer by call id, its interpreter's spend the loop's. */
async function askQuestion(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  { call, tool, approval, shown }: QuestionCall,
  config: RunnableConfig | undefined,
): Promise<AgentLoopUpdate> {
  // arguments that are no valid ask ask nobody: the preparing found that already (#1295c)
  checkBeforeAsking(state, deps, tool);
  const reply = await askedOrFailed(
    state,
    deps,
    () => approval.requestAnswer(shown, deps.agent.name, tool, config?.signal),
    true,
  );
  const answered = { tool: tool.name, answer: reply.answer, by: reply.by };
  return { questionAnswers: { [call.callId]: answered }, usage: [...reply.usage] };
}
