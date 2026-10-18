import { interrupt, isGraphInterrupt } from "@langchain/langgraph";
import { redactedArguments } from "../../dto/redact.js";
import { validate } from "../../dto/schema.js";
import {
  ToolCallApprovalDecisionDto,
  type ToolCallApprovalAskDto,
} from "../../dto/standard/framework.js";
import type { PendingPause } from "../../pause/index.js";
import type { AnyTool } from "../../tools/index.js";
import type { ChannelRequest, InboundChannelAdapter } from "../../components/decorators.js";
import type { ObserverManager } from "../../core/observer-manager.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";

/**
 * How the loop gets a decision on a tool call before it runs — one call per ask. It is backed by the
 * pause seam: the run pauses, the tool's channel is asked, and `resume` brings the decision.
 */
export interface ToolCallApproval {
  readonly requestApproval: (
    ask: ToolCallApprovalAskDto,
    agent: string,
    tool: AnyTool,
    run: { readonly runId: string; readonly threadId: string },
  ) => Promise<ToolCallApprovalDecisionDto>;
}

/** Where an ask goes and how a reply comes back: the workflow's channels and their adapters. */
export interface ApprovalChannels {
  readonly dispatch?: (channelName: string, req: ChannelRequest) => Promise<void>;
  readonly adapterOf?: (channel: string) => InboundChannelAdapter | undefined;
  readonly observer?: ObserverManager;
}

interface AskContext {
  readonly ask: ToolCallApprovalAskDto;
  readonly agent: string;
  readonly tool: AnyTool;
  readonly runId: string;
  readonly threadId: string;
}

/**
 * The run just paused at the ask: the tool's channel gets the request (once per pause), its
 * arguments with the input DTO's `sensitive` fields masked — a channel shows them to people (#202).
 */
async function askChannel(channels: ApprovalChannels, ctx: AskContext): Promise<void> {
  const channel = ctx.tool.channel;
  if (channel === undefined || channels.dispatch === undefined) return;
  const shown = redactedArguments(ctx.tool.input, ctx.ask.arguments);
  const { observer } = channels;
  await reportNodeEvent((base) =>
    observer?.onChannelStart({ ...base, name: channel, input: shown }),
  );
  await channels.dispatch(channel, {
    runId: ctx.runId,
    agentName: ctx.agent,
    toolName: ctx.tool.name,
    toolArguments: shown,
  });
}

/** The reply `resume` brought, read by the channel's inbound adapter when it has one. */
async function interpretReply(
  channels: ApprovalChannels,
  ctx: AskContext,
  raw: unknown,
): Promise<unknown> {
  const channel = ctx.tool.channel;
  if (channel === undefined) return raw;
  const { observer } = channels;
  await reportNodeEvent((base) => observer?.onChannelEnd({ ...base, name: channel, update: raw }));
  const adapter = channels.adapterOf?.(channel);
  if (adapter === undefined) return raw;
  const interpreted: unknown = await adapter.interpret(raw);
  return interpreted;
}

/**
 * The pause seam as an approval: `interrupt` pauses the run at the call (the checkpoint is the
 * boundary — nothing ran before it) and the tool's channel is asked; on resume `interrupt` returns
 * the reply, which the channel's adapter interprets and which is validated like any external input.
 */
export function pauseSeamApproval(channels: ApprovalChannels = {}): ToolCallApproval {
  return {
    requestApproval: async (ask, agent, tool, run) => {
      const ctx: AskContext = { ask, agent, tool, ...run };
      const pending: PendingPause = {
        kind: "approval",
        agent,
        callId: ask.callId,
        tool: ask.tool,
        // what the caller and the paused-run store see: `sensitive` fields masked (#202)
        args: redactedArguments(tool.input, ask.arguments),
      };
      let raw: unknown;
      try {
        raw = interrupt<PendingPause, unknown>(pending);
      } catch (e) {
        if (isGraphInterrupt(e)) await askChannel(channels, ctx);
        throw e;
      }
      return validate(ToolCallApprovalDecisionDto, await interpretReply(channels, ctx, raw));
    },
  };
}
