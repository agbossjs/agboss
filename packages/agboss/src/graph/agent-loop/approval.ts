import { randomBytes } from "node:crypto";
import { interrupt, isGraphInterrupt } from "@langchain/langgraph";
import { redactedArguments } from "../../dto/redact.js";
import { validate } from "../../dto/schema.js";
import {
  ToolCallApprovalDecisionDto,
  type ToolCallApprovalAskDto,
} from "../../dto/standard/framework.js";
import type { PendingPause } from "../../pause/index.js";
import type { AnyTool } from "../../tools/index.js";
import type { ChannelSender } from "../../channels/channel-sender.js";
import { ChannelOutcomeKind, isChannelOutcome } from "../../channels/channel-outcome.js";
import type { ExecutionObserverManager } from "../../core/observer-manager.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";

/**
 * How the loop gets a decision on a tool call before it runs — one call per ask. It is backed by the
 * pause seam: the tool's channel is asked once; it answers now (`ChannelOutcome.decided`) or the
 * run pauses (`awaitReply`) and `resume` brings the decision.
 */
export interface ToolCallApproval {
  readonly requestApproval: (
    ask: ToolCallApprovalAskDto,
    agent: string,
    tool: AnyTool,
  ) => Promise<ToolCallApprovalDecisionDto>;
}

/** Where an ask goes: the channels the tools name, by name (#267). */
export interface ApprovalChannels {
  readonly channelOf?: (channelName: string) => ChannelSender;
  readonly observer?: ExecutionObserverManager;
}

/** A pause's id: a random 128-bit token, made once per pause before its `send` (#267 AC3). */
const newPauseId = (): string => randomBytes(16).toString("hex");

/** The decision the channel gave now; `undefined` when the run waits for the reply. */
async function askChannel(
  channels: ApprovalChannels,
  ask: ToolCallApprovalAskDto,
  channel: string,
): Promise<{ readonly decision: unknown } | undefined> {
  if (channels.channelOf === undefined) return undefined;
  const { observer } = channels;
  await reportNodeEvent((base) =>
    observer?.onChannelStart({ ...base, name: channel, input: ask.arguments }),
  );
  const outcome: unknown = await channels
    .channelOf(channel)
    .send({ pauseId: newPauseId(), value: ask });
  if (!isChannelOutcome(outcome)) {
    throw new TypeError(
      `channel ${channel}: send() must return ChannelOutcome.awaitReply() or ChannelOutcome.decided(…)`,
    );
  }
  return outcome.kind === ChannelOutcomeKind.Decided ? { decision: outcome.decision } : undefined;
}

/** The decision (a reply or the channel's own), reported and validated like any external input. */
async function decisionOf(
  channels: ApprovalChannels,
  channel: string,
  decision: unknown,
): Promise<ToolCallApprovalDecisionDto> {
  const { observer } = channels;
  await reportNodeEvent((base) =>
    observer?.onChannelEnd({ ...base, name: channel, update: decision }),
  );
  return validate(ToolCallApprovalDecisionDto, decision);
}

/**
 * The pause seam as an approval: `interrupt` stops the run at the call (the checkpoint is the
 * boundary — nothing ran before it) and the tool's channel is asked, once — on resume `interrupt`
 * returns the reply and the channel is not asked again. A channel that decides at once
 * (`ChannelOutcome.decided`) takes the interrupt back: the step goes on with no pause.
 */
export function pauseSeamApproval(channels: ApprovalChannels = {}): ToolCallApproval {
  return {
    requestApproval: async (ask, agent, tool) => {
      const channel = tool.channel ?? "";
      // what the channel, the caller and the paused-run store see: `sensitive` fields masked (#202)
      const shown: ToolCallApprovalAskDto = {
        callId: ask.callId,
        tool: ask.tool,
        arguments: redactedArguments(tool.input, ask.arguments),
        summary: ask.summary,
      };
      const pending: PendingPause = {
        kind: "approval",
        agent,
        callId: ask.callId,
        tool: ask.tool,
        args: shown.arguments,
      };
      let reply: unknown;
      try {
        reply = interrupt<PendingPause, unknown>(pending);
      } catch (error) {
        if (!isGraphInterrupt(error)) throw error;
        const decided = await askChannel(channels, shown, channel);
        if (decided === undefined) throw error;
        reply = decided.decision;
      }
      return decisionOf(channels, channel, reply);
    },
  };
}
