import type { FrameworkLog } from "../../infrastructure/logger.js";
import { interrupt, isGraphInterrupt } from "@langchain/langgraph";
import { redactedArguments, redactedDto } from "../../dto/redact.js";
import { validate } from "../../dto/schema.js";
import type { UsageRecord } from "../../finops/usage.js";
import { PauseKind, pauseInputOf } from "../../infrastructure/pause-record.js";
import type { PauseToolCallSummary } from "../../channels/pause-contexts.js";
import { toolRecordOf } from "../../flow/runtime/tool-keys.js";
import type { ComponentRecord } from "../../flow/runtime/records.js";
import type { ToolCallApprovalAskDto } from "../../dto/standard/framework.js";
import type { AnyTool } from "../../tools/index.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import type { PauseAnswerLog } from "../../infrastructure/pause-answer-log.js";
import type { PauseNotices } from "../../pause/index.js";
import { ChannelOutcomeKind, isChannelOutcome } from "../../channels/channel-outcome.js";
import type { ExecutionObserverManager } from "../../core/observer-manager.js";
import { currentFrame } from "../../flow/context/frame.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";
import {
  pauseStep,
  sentBy,
  THREAD_OWNER,
  type PauseTarget,
  type StepAnswer,
} from "../../flow/runtime/pause.js";
import {
  approvalDecisionOf,
  validDecisionOf,
  type ApprovalDecision,
} from "../../channels/decision.js";
import { systemClock, type Clock } from "../../infrastructure/clock.js";

/**
 * How the loop gets a decision on a tool call before it runs — one call per ask. It is backed by the
 * pause seam (#267 S35): the call's pause is recorded, its channel asked once; it answers now
 * (`ChannelOutcome.decided`) or the run pauses (`awaitReply`) until a resume records the decision.
 */
export interface ToolCallApproval {
  readonly requestApproval: (
    ask: ToolCallApprovalAskDto,
    agent: string,
    tool: AnyTool,
    signal?: AbortSignal,
  ) => Promise<ApprovalDecision>;
  /**
   * Asks a question role an agent calls (#712): its call's arguments are the role's ask, the
   * answer — validated as the role's `answer` — is the call's result.
   */
  readonly requestAnswer: (
    args: Readonly<Record<string, unknown>>,
    agent: string,
    tool: AnyTool,
    signal?: AbortSignal,
  ) => Promise<QuestionReply>;
}

/** A question call's answer (#712): the role's answer, validated, who gave it, what reading it cost. */
export interface QuestionReply {
  readonly answer: unknown;
  readonly by: string;
  readonly usage: readonly UsageRecord[];
}

/** Where an ask goes: the pause targets the tools name, by name (#267, #1307), and the record of pauses. */
export interface ApprovalChannels {
  readonly targetOf?: (targetName: string) => PauseTarget;
  /** The application's pauses; absent for an agent loop run on its own (no records, no ids). */
  readonly pauses?: PausedExecutionRepository;
  /** Where a pause its channel decided at once is logged (with `pauses`). */
  readonly answers?: PauseAnswerLog;
  /** Who hears of a pause's change (#940). */
  readonly notices?: PauseNotices | undefined;
  readonly observer?: ExecutionObserverManager;
  /** The application's clock: when each pause was asked and decided (default: the system's). */
  readonly clock?: Clock;
  /** Where a working calendar that fails is logged (#944). */
  readonly log?: FrameworkLog | undefined;
}

/** The ask as the channel, the caller and the pause records see it: `sensitive` fields masked. */
const shownAsk = (ask: ToolCallApprovalAskDto, tool: AnyTool): ToolCallApprovalAskDto => ({
  callId: ask.callId,
  tool: ask.tool,
  arguments: redactedArguments(tool.input, ask.arguments),
  summary: ask.summary,
});

/** One ask through the pause seam: its target, what it shows, how its answer is validated. */
interface SeamAsk {
  /** An approval of the call, or an external task asked through the agent's tool (#712). */
  readonly kind: PauseKind;
  /** The name of the pause target it waits under. */
  readonly target: string;
  readonly agent: string;
  /** What it asks as a loop on its own is interrupted with: the call as the approver sees it, or the ask. */
  readonly shown: unknown;
  /** What it asks, as the record keeps it and `onChannelStart` reports it. */
  readonly input: Readonly<Record<string, unknown>>;
  /** The tool call an approval waits on. */
  readonly toolCall?: PauseToolCallSummary;
  readonly validate: (decision: unknown) => unknown;
  /** The record's component when it is not the asking step's own (an external task, #712). */
  readonly component?: ComponentRecord;
}

/**
 * The loop on its own (no application, no records): `interrupt` first, its resume value is the
 * decision, answered by whoever runs the loop.
 */
async function interruptedAnswer(
  channels: ApprovalChannels,
  ask: SeamAsk,
  signal: AbortSignal | undefined,
): Promise<StepAnswer> {
  try {
    const decision = interrupt<unknown, unknown>(ask.shown);
    return { decision, by: THREAD_OWNER, usage: [] };
  } catch (error) {
    if (!isGraphInterrupt(error) || channels.targetOf === undefined) throw error;
    // a loop on its own has no record: its target's only channel decides at once, or the interrupt stands
    const [channel] = [...channels.targetOf(ask.target).channels.values()];
    if (channel === undefined) throw error;
    const outcome = await sentBy(
      channel,
      {
        pauseId: "",
        input: ask.input,
        ...(ask.toolCall === undefined ? {} : { toolCall: ask.toolCall }),
        trail: [],
      },
      signal,
    );
    if (!isChannelOutcome(outcome) || outcome.kind !== ChannelOutcomeKind.Decided) throw error;
    return { decision: outcome.decision, by: channel.name, usage: [] };
  }
}

/** Asks through the pause seam: the step's pause recorded and its channel asked once, or an interrupt. */
async function seamAnswer(
  channels: ApprovalChannels,
  ask: SeamAsk,
  signal: AbortSignal | undefined,
): Promise<StepAnswer> {
  const { observer, pauses, answers, targetOf } = channels;
  const frame = currentFrame();
  const onSend = (): Promise<void> =>
    reportNodeEvent((base) =>
      observer?.onChannelStart({ ...base, name: ask.target, input: ask.input }),
    );
  const question = {
    kind: ask.kind,
    step: ask.agent,
    input: ask.input,
    ...(ask.toolCall === undefined ? {} : { toolCall: ask.toolCall }),
    ...(ask.component === undefined ? {} : { component: ask.component }),
  };
  const answer =
    pauses === undefined || answers === undefined || frame === undefined || targetOf === undefined
      ? await interruptedAnswer(channels, ask, signal)
      : await pauseStep(
          {
            pauses,
            answers,
            target: targetOf(ask.target),
            frame,
            signal,
            clock: channels.clock ?? systemClock,
            validate: ask.validate,
            onSend,
            notices: channels.notices,
            log: channels.log,
          },
          question,
        );
  await reportNodeEvent((base) =>
    observer?.onChannelEnd({ ...base, name: ask.target, output: answer.decision }),
  );
  return answer;
}

/** The pause seam as an approval: the call's pause answered, its decision validated on the way in. */
export function pauseSeamApproval(channels: ApprovalChannels = {}): ToolCallApproval {
  return {
    requestApproval: async (ask, agent, tool, signal) => {
      const shown = shownAsk(ask, tool);
      const validate = (decision: unknown): unknown => validDecisionOf(decision, tool);
      const target = tool.approval ?? "";
      const toolCall = { callId: shown.callId, tool: shown.tool, summary: shown.summary };
      const input = pauseInputOf(shown.arguments);
      const seam = {
        kind: PauseKind.Approval,
        ...{ target, agent, shown, input, toolCall, validate },
      };
      const answer = await seamAnswer(channels, seam, signal);
      return approvalDecisionOf(answer.decision, tool, answer.by, answer.usage);
    },
    requestAnswer: async (args, agent, tool, signal) => {
      const { question } = tool;
      if (question === undefined) throw new TypeError(`${tool.name} asks no question`);
      // the question as the channel, the records and the events see it: `sensitive` fields masked
      const shown = pauseInputOf(redactedDto(question.ask, args));
      const answered = (decision: unknown): unknown => validate(question.answer, decision);
      const target = tool.approval ?? tool.name;
      const component = toolRecordOf(tool);
      const kind = PauseKind.ExternalTask;
      const seam = { kind, target, agent, shown, input: shown, validate: answered, component };
      const answer = await seamAnswer(channels, seam, signal);
      return { answer: answered(answer.decision), by: answer.by, usage: answer.usage };
    },
  };
}
