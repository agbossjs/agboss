import { interrupt, isGraphInterrupt } from "@langchain/langgraph";
import { redactedArguments } from "../../dto/redact.js";
import type { ToolCallApprovalAskDto } from "../../dto/standard/framework.js";
import type { AnyTool } from "../../tools/index.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import { ChannelOutcomeKind, isChannelOutcome } from "../../channels/channel-outcome.js";
import type { ExecutionObserverManager } from "../../core/observer-manager.js";
import { currentFrame } from "../../flow/context/frame.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";
import {
  pauseStep,
  THREAD_OWNER,
  type PauseAnswer,
  type PauseChannel,
} from "../../flow/runtime/pause.js";
import { approvalDecisionOf, type ApprovalDecision } from "../../channels/decision.js";

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
}

/** Where an ask goes: the channels the tools name, by name (#267), and the record of pauses. */
export interface ApprovalChannels {
  readonly channelOf?: (channelName: string) => PauseChannel;
  /** The application's pauses; absent for an agent loop run on its own (no records, no ids). */
  readonly pauses?: PausedExecutionRepository;
  readonly observer?: ExecutionObserverManager;
}

/** The ask as the channel, the caller and the pause records see it: `sensitive` fields masked. */
const shownAsk = (ask: ToolCallApprovalAskDto, tool: AnyTool): ToolCallApprovalAskDto => ({
  callId: ask.callId,
  tool: ask.tool,
  arguments: redactedArguments(tool.input, ask.arguments),
  summary: ask.summary,
});

/**
 * The loop on its own (no application, no records): `interrupt` first, its resume value is the
 * decision, answered by whoever runs the loop.
 */
async function interruptedAnswer(
  channels: ApprovalChannels,
  shown: ToolCallApprovalAskDto,
  channel: string,
): Promise<PauseAnswer> {
  try {
    return { decision: interrupt<ToolCallApprovalAskDto, unknown>(shown), by: THREAD_OWNER };
  } catch (error) {
    if (!isGraphInterrupt(error) || channels.channelOf === undefined) throw error;
    const outcome: unknown = await channels
      .channelOf(channel)
      .sender.send({ pauseId: "", value: shown });
    if (!isChannelOutcome(outcome) || outcome.kind !== ChannelOutcomeKind.Decided) throw error;
    return { decision: outcome.decision, by: channel };
  }
}

/** The pause seam as an approval: the call's pause answered, its decision validated on the way in. */
export function pauseSeamApproval(channels: ApprovalChannels = {}): ToolCallApproval {
  return {
    requestApproval: async (ask, agent, tool, signal) => {
      const channel = tool.channel ?? "";
      const shown = shownAsk(ask, tool);
      const { observer, pauses, channelOf } = channels;
      const frame = currentFrame();
      const onSend = (): Promise<void> =>
        reportNodeEvent((base) =>
          observer?.onChannelStart({ ...base, name: channel, input: shown.arguments }),
        );
      const answer =
        pauses === undefined || frame === undefined || channelOf === undefined
          ? await interruptedAnswer(channels, shown, channel)
          : await pauseStep(
              { pauses, channel: channelOf(channel), frame, signal, onSend },
              { agent, ask: shown },
            );
      await reportNodeEvent((base) =>
        observer?.onChannelEnd({ ...base, name: channel, update: answer.decision }),
      );
      return approvalDecisionOf(answer.decision, tool, answer.by);
    },
  };
}
