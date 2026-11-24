import { calendarNameOf } from "../calendar/calendar-source.js";
import type { AssembledApplication } from "../application/assemble.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class } from "../components/injection.js";
import { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";
import { channelInterpreterOf } from "../channels/channel-interpreter.js";
import {
  findPauseTarget,
  isExternalTask,
  type FoundPauseTarget,
  type PauseTargetOverlay,
} from "../channels/pause-targets.js";
import { channelsOf } from "../channels/channel-rules.js";
import { channelUsesOf, type ChannelUse } from "../channels/discovery.js";
import { dtoLabel } from "../flow/analyse/labels.js";
import { durationLabel } from "../units/duration-label.js";
import { isWorkingDuration } from "../units/index.js";
import { amountOf } from "../units/working-time.js";
import { PauseRespondent } from "../pause/respondent.js";

/**
 * The pause targets of an application as `agboss describe` shows them (#267, #268 AC4): for each
 * `@ToolApproval` a tool names and each `@ExternalTask` a step or an agent asks, its input → output
 * (a tool approval's input is the tool input it approves), who may answer, its channel
 * interpreter, and the channels that serve it. Read from the decorators only.
 */

/** Why a channel class is the one that sends a target's pauses. */
export enum ChannelImplementationReason {
  /** The `@Channel({ target })` classes listed in `@Application({ channels })`. */
  Listed = "listed",
}

/** One pause target of the application, with the channels that serve it. */
export interface DescribedChannel {
  /** The target's name. */
  readonly name: string;
  /** The target's class. */
  readonly className: string;
  /** Always `true`: a pause target is the domain side a channel serves (kept for the readers of `describe --json`). */
  readonly isRole: boolean;
  /** What a pause asks: the target's `input`, or the tool input it approves. */
  readonly question: string;
  /** What answers it: the target's `output`, or `ToolCallApprovalDecisionDto` for an approval. */
  readonly answer: string;
  /** Who may answer its pauses. */
  readonly respondent: PauseRespondent;
  /** How long a pause of the role waits (#941), in ms; absent: no deadline of its own. */
  readonly expiresIn?: number;
  /** `true` when `expiresIn` is working time (#944): counted by the role's calendar, not the wall clock. */
  readonly isExpiresInWorking?: true;
  /** How long before its deadline the role's pauses are reminded (#942), in ms; absent: no reminder. */
  readonly remindBefore?: number;
  /** `true` when `remindBefore` is working time (#944). */
  readonly isRemindBeforeWorking?: true;
  /** The name of the calendar the role itself names (#944): `working-week` or its `@WorkingCalendar`'s; absent = the application's. */
  readonly workingCalendar?: string;
  /** The role's `@ChannelInterpreter`, by name. */
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

/** The target's `timeout` / `remindBefore` in ms, each flagged when it is working time (#944). */
function timesOf(
  options: FoundPauseTarget["options"],
): Pick<
  DescribedChannel,
  "expiresIn" | "isExpiresInWorking" | "remindBefore" | "isRemindBeforeWorking"
> {
  const { timeout, remindBefore } = options;
  return {
    expiresIn: amountOf(timeout),
    ...(isWorkingDuration(timeout) ? { isExpiresInWorking: true as const } : {}),
    ...(remindBefore === undefined ? {} : { remindBefore: amountOf(remindBefore) }),
    ...(isWorkingDuration(remindBefore) ? { isRemindBeforeWorking: true as const } : {}),
  };
}

/** The target's options with a profile's deadline and reminder over its own. */
const withProfile = (
  declared: FoundPauseTarget["options"],
  changed: PauseTargetOverlay | undefined,
): FoundPauseTarget["options"] => ({
  ...declared,
  ...(changed?.timeout === undefined ? {} : { timeout: changed.timeout }),
  ...(changed?.remindBefore === undefined ? {} : { remindBefore: changed.remindBefore }),
});

function describedTarget(
  found: FoundPauseTarget,
  changed: PauseTargetOverlay | undefined,
  uses: readonly ChannelUse[],
  modules: readonly ProviderModule[],
): DescribedChannel {
  const options = withProfile(found.options, changed);
  const channels = channelsOf(found.target, modules);
  const interpreter =
    options.channelInterpreter === undefined
      ? undefined
      : channelInterpreterOf(options.channelInterpreter)?.options.name;
  const external = isExternalTask(options);
  return {
    name: options.name,
    className: found.target.name,
    isRole: true,
    question: external
      ? dtoLabel(options.input)
      : options.input === undefined
        ? inputsLabel(uses)
        : dtoLabel(options.input),
    answer: dtoLabel(external ? options.output : ToolCallApprovalDecisionDto),
    respondent: options.respondent,
    ...timesOf(options),
    ...(options.calendar === undefined
      ? {}
      : { workingCalendar: calendarNameOf(options.calendar) }),
    ...(interpreter === undefined ? {} : { replyInterpreter: interpreter }),
    ...(channels.length === 0
      ? {}
      : {
          implementation: channels.map((channel) => channel.name).join(", "),
          reason: ChannelImplementationReason.Listed,
        }),
    tools: uses.filter((use) => use.isQuestion !== true).map(toolLabel),
    ...(external ? { askedBy: uses.filter((use) => use.isQuestion === true).map(toolLabel) } : {}),
  };
}

/** Every pause target the application's tools and steps name, each once, in the order first named. */
export function describedChannelsOf(assembled: AssembledApplication): readonly DescribedChannel[] {
  const uses = channelUsesOf(assembled.workflows.map((workflow) => workflow.graph.type));
  const byTarget = new Map<Class, ChannelUse[]>();
  for (const use of uses) byTarget.set(use.target, [...(byTarget.get(use.target) ?? []), use]);
  return [...byTarget].flatMap(([target, named]) => {
    const found = findPauseTarget(target);
    return found === undefined
      ? []
      : [
          describedTarget(
            found,
            assembled.pauseOverrides?.get(found.options.name),
            named,
            assembled.modules,
          ),
        ];
  });
}

const ANSWERED_BY: Readonly<Record<PauseRespondent, string>> = {
  [PauseRespondent.Owner]: "the thread's owner",
  [PauseRespondent.Delegate]: "the channel",
};

const REASONS: Readonly<Record<ChannelImplementationReason, string>> = {
  [ChannelImplementationReason.Listed]: "listed in @Application channels",
};

/** The label of a length that is working time or not (#944). */
const labelOf = (amount: number, isWorking: true | undefined): string =>
  isWorking === true ? `${durationLabel(amount)} of working time` : durationLabel(amount);

/** ` · expires in 24 h` (#941): the role's deadline for an answer; nothing without one. */
const expiryOf = (channel: DescribedChannel): string =>
  (channel.expiresIn === undefined
    ? ""
    : ` · expires in ${labelOf(channel.expiresIn, channel.isExpiresInWorking)}`) +
  (channel.remindBefore === undefined
    ? ""
    : ` · reminds ${labelOf(channel.remindBefore, channel.isRemindBeforeWorking)} before`);

/** `payout-tool-approval (PayoutToolApproval): PayoutRequestDto → … · channel …`. */
function channelLine(channel: DescribedChannel): string {
  const implementation =
    channel.implementation === undefined || channel.reason === undefined
      ? "no channel"
      : `${channel.implementation} (${REASONS[channel.reason]})`;
  const interpreter =
    channel.replyInterpreter === undefined
      ? channel.askedBy === undefined
        ? ""
        : " · no channel interpreter (answered with a decision only)"
      : ` · channel interpreter ${channel.replyInterpreter}`;
  return (
    `  ${channel.name} (${channel.className}): ${channel.question} → ${channel.answer}` +
    ` · answered by ${ANSWERED_BY[channel.respondent]}${expiryOf(channel)}${interpreter} · ${implementation}` +
    usedByOf(channel)
  );
}

/** Who uses a channel: the tools that name it, or the question steps that ask it (#659). */
const usedByOf = (channel: DescribedChannel): string =>
  channel.askedBy === undefined
    ? ` · tools ${channel.tools.join(", ")}`
    : ` · asked at ${channel.askedBy.join(", ")}${channel.tools.length === 0 ? "" : ` · tools ${channel.tools.join(", ")}`}`;

/** `channels` — one line per pause target; `channels none` when no tool or step names one. */
export function channelLines(assembled: AssembledApplication): string[] {
  const channels = describedChannelsOf(assembled);
  return channels.length === 0 ? ["channels none"] : ["channels", ...channels.map(channelLine)];
}
