import type { AssembledApplication } from "../application/assemble.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";
import {
  channelRoleOf,
  isQuestionRole,
  PauseAnswerer,
  replyInterpreterOf,
  type StoredChannelRole,
} from "../channels/channel-role.decorator.js";
import { implementationsOf } from "../channels/channel-rules.js";
import { channelUsesOf, type ChannelUse } from "../channels/discovery.js";
import { dtoLabel } from "../flow/analyse/labels.js";

/**
 * The channels of an application as `agboss describe` shows them (#267, #268 AC4): for each role a
 * tool names, its question → answer (an approval role's question is the tool input it approves),
 * who may answer, its reply interpreter, and its one implementation with why; a concrete `@Channel`
 * named as is approves its tools' input and is answered by the thread's owner. Read from the
 * decorators only.
 */

/** Why a channel class is the one that sends. */
export enum ChannelImplementationReason {
  /** The one `@Channel` that extends the role, listed in `@Application({ providers })`. */
  Listed = "listed",
  /** A concrete `@Channel` named by the tool: used as is. */
  NamedByTool = "named-by-tool",
}

/** One channel of the application. */
export interface DescribedChannel {
  /** The role's name, or the concrete channel's. */
  readonly name: string;
  /** The class the tools name: a role, or a concrete channel. */
  readonly className: string;
  readonly isRole: boolean;
  /** What a pause asks: the role's `ask`, or the tool input it approves. */
  readonly question: string;
  /** What answers it: the role's `answer`, or `ToolCallApprovalDecisionDto` for an approval. */
  readonly answer: string;
  /** Who may answer its pauses. */
  readonly answerer: PauseAnswerer;
  /** @deprecated 0.1.0's name of `answerer`, emitted until 0.2: use `answerer`. */
  readonly answeredBy: PauseAnswerer;
  /** The role's `@ReplyInterpreter`, by name. */
  readonly replyInterpreter?: string;
  /** The class that sends; absent for a role with none listed (assembly rejects it). */
  readonly implementation?: string;
  readonly reason?: ChannelImplementationReason;
  /** The tools that name it: `pay-out-tool (treasury-workflow)`. */
  readonly tools: readonly string[];
  /**
   * The question steps that ask it (#659): `spending-limit-question (purchase-workflow)` — and the
   * agents that ask it through their tool loop (#712): `buyer-agent's tool loop (buyer-workflow)`.
   */
  readonly askedBy?: readonly string[];
}

const toolLabel = (use: ChannelUse): string =>
  use.askedBy === undefined
    ? `${use.tool} (${use.workflow})`
    : `${use.askedBy}'s tool loop (${use.workflow})`;

const inputsLabel = (uses: readonly ChannelUse[]): string =>
  [...new Set(uses.map((use) => dtoLabel(use.toolInput)))].join(" | ");

function roleChannel(
  role: Class,
  options: StoredChannelRole,
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
): DescribedChannel {
  const [implementation] = implementationsOf(role, modules);
  const interpreter =
    options.replyInterpreter === undefined
      ? undefined
      : replyInterpreterOf(options.replyInterpreter)?.options.name;
  return {
    name: options.name,
    className: role.name,
    isRole: true,
    question: dtoLabel(isQuestionRole(options) ? options.ask : options.approves),
    answer: dtoLabel(isQuestionRole(options) ? options.answer : ToolCallApprovalDecisionDto),
    answerer: options.answerer,
    answeredBy: options.answerer,
    ...(interpreter === undefined ? {} : { replyInterpreter: interpreter }),
    ...(implementation === undefined
      ? {}
      : { implementation: implementation.name, reason: ChannelImplementationReason.Listed }),
    tools: uses.filter((use) => use.isQuestion !== true).map(toolLabel),
    ...(isQuestionRole(options)
      ? { askedBy: uses.filter((use) => use.isQuestion === true).map(toolLabel) }
      : {}),
  };
}

function concreteChannel(channel: Class, uses: readonly ChannelUse[]): DescribedChannel {
  const component = componentOf(channel);
  const name = component?.kind === "channel" ? component.meta.name : channel.name;
  return {
    name,
    className: channel.name,
    isRole: false,
    question: inputsLabel(uses),
    answer: dtoLabel(ToolCallApprovalDecisionDto),
    answerer: PauseAnswerer.ThreadOwner,
    answeredBy: PauseAnswerer.ThreadOwner,
    implementation: channel.name,
    reason: ChannelImplementationReason.NamedByTool,
    tools: uses.map(toolLabel),
  };
}

/** Every channel the application's tools name, each once, in the order first named. */
export function describedChannelsOf(assembled: AssembledApplication): readonly DescribedChannel[] {
  const uses = channelUsesOf(assembled.workflows.map((workflow) => workflow.graph.type));
  const byChannel = new Map<Class, ChannelUse[]>();
  for (const use of uses) byChannel.set(use.channel, [...(byChannel.get(use.channel) ?? []), use]);
  return [...byChannel].map(([channel, named]) => {
    const role = channelRoleOf(channel);
    return role?.role === channel
      ? roleChannel(channel, role.options, named, assembled.modules)
      : concreteChannel(channel, named);
  });
}

const ANSWERED_BY: Readonly<Record<PauseAnswerer, string>> = {
  [PauseAnswerer.ThreadOwner]: "the thread's owner",
  [PauseAnswerer.Channel]: "the channel",
};

const REASONS: Readonly<Record<ChannelImplementationReason, string>> = {
  [ChannelImplementationReason.Listed]: "listed in @Application providers",
  [ChannelImplementationReason.NamedByTool]: "a @Channel named by the tool, used as is",
};

/** `payout-approval-channel (PayoutApprovalChannel): PayoutRequestDto → … · implementation …`. */
function channelLine(channel: DescribedChannel): string {
  const implementation =
    channel.implementation === undefined || channel.reason === undefined
      ? "no implementation"
      : `${channel.implementation} (${REASONS[channel.reason]})`;
  const interpreter =
    channel.replyInterpreter === undefined
      ? channel.askedBy === undefined
        ? ""
        : " · no reply interpreter (answered with a decision only)"
      : ` · reply interpreter ${channel.replyInterpreter}`;
  return (
    `  ${channel.name} (${channel.className}): ${channel.question} → ${channel.answer}` +
    ` · answered by ${ANSWERED_BY[channel.answerer]}${interpreter} · ${implementation}` +
    usedByOf(channel)
  );
}

/** Who uses a channel: the tools that name it, or the question steps that ask it (#659). */
const usedByOf = (channel: DescribedChannel): string =>
  channel.askedBy === undefined
    ? ` · tools ${channel.tools.join(", ")}`
    : ` · asked at ${channel.askedBy.join(", ")}${channel.tools.length === 0 ? "" : ` · tools ${channel.tools.join(", ")}`}`;

/** `channels` — one line per channel; `channels none` when no tool names one. */
export function channelLines(assembled: AssembledApplication): string[] {
  const channels = describedChannelsOf(assembled);
  return channels.length === 0 ? ["channels none"] : ["channels", ...channels.map(channelLine)];
}
