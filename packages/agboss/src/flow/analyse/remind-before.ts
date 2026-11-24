import { PAUSE_TIMERS_EVERY } from "../../application/pause-timers.js";
import {
  channelRoleOf,
  channelRoleOptionsOf,
  type StoredChannelRole,
} from "../../channels/channel-role.decorator.js";
import { isExpiresIn, isNotShorter, isRemindBefore } from "../../channels/channel-rules.js";
import { isWorkingDuration } from "../../units/index.js";
import { spanText } from "../../units/working-time.js";
import type { Class } from "../../components/injection.js";
import { componentOf } from "../../components/metadata.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { NodeKind } from "../ast.js";
import { expiresInOfQuestion, questionExpiriesOf } from "./question-expiry.js";
import type { AnalysisContext } from "./rules/context.js";

/**
 * The warning `[channel.remind-before-exceeds-expiry]` (#942, Q6): a question step's or a tool's
 * `expiresIn` that is no longer than its role's `remindBefore` — such a pause is made less than a
 * reminder's lead before its deadline, so it gets no reminder (the role alone sets `remindBefore`).
 * An error under `--strict`.
 *
 * And `[channel.remind-before-below-tick]` (#1099): a role's `remindBefore` shorter than the pause
 * timers' tick (`PAUSE_TIMERS_EVERY`, 5 s) — the reminder's window `[deadline − remindBefore,
 * deadline)` is then shorter than the look's period, so a tick can fall on none of it and the
 * reminder is skipped without a trace. A warning, an error under `--strict`.
 */

/** Whether the pause's `expiresIn` leaves no room for the role's reminder. */
const leavesNoRoom = (expiresIn: unknown, remindBefore: unknown): boolean =>
  isExpiresIn(expiresIn) && isRemindBefore(remindBefore) && isNotShorter(remindBefore, expiresIn);

/** `14400000 ms`, or `7200000 ms of working time`. */
const msOf = (span: unknown): string =>
  isWorkingDuration(span) ? spanText(span) : `${String(span)} ms`;

const message = (owner: string, expiresIn: unknown, role: string, remindBefore: unknown): string =>
  `${owner}: expiresIn (${msOf(expiresIn)}) is not longer than ${role}'s remindBefore (${msOf(remindBefore)}) — its pauses get no reminder`;

/**
 * The same for working time (#944): both in working time, the working amounts compare — the
 * calendar is not called and the pause gets no reminder; known at assembly.
 */

/** The question steps whose `expiresIn` leaves no room for their role's reminder. */
function questionWarnings(context: AnalysisContext): RuleViolation[] {
  const expiries = questionExpiriesOf(context.workflow.flow);
  return [...expiries.keys()].flatMap((question) => {
    const role = channelRoleOptionsOf(question);
    const expiresIn = expiresInOfQuestion(expiries, question);
    if (role === undefined || !leavesNoRoom(expiresIn, role.remindBefore)) return [];
    const text = message(role.name, expiresIn, "its role", role.remindBefore);
    return [violation("channel.remind-before-exceeds-expiry", text, [role.name])];
  });
}

/** The tools of the agents of the workflow, each class once. */
function toolsOf(context: AnalysisContext): readonly Class[] {
  const tools = [...context.graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === NodeKind.Agent ? (node.declaration.options.tools ?? []) : [],
  );
  return [...new Set(tools)];
}

/** The tools whose `expiresIn` leaves no room for their channel role's reminder. */
function toolWarnings(context: AnalysisContext): RuleViolation[] {
  return toolsOf(context).flatMap((cls) => {
    const component = componentOf(cls);
    if (component?.kind !== "tool") return [];
    const { name, channel, expiresIn } = component.meta;
    const role = channel === undefined ? undefined : channelRoleOf(channel)?.options;
    if (role === undefined || !leavesNoRoom(expiresIn, role.remindBefore)) return [];
    const text = message(name, expiresIn, role.name, role.remindBefore);
    return [violation("channel.remind-before-exceeds-expiry", text, [name])];
  });
}

/** `[channel.remind-before-exceeds-expiry]` over a workflow's question steps and tools. */
export const remindBeforeWarnings = (context: AnalysisContext): readonly RuleViolation[] => [
  ...questionWarnings(context),
  ...toolWarnings(context),
  ...remindBeforeBelowTickWarnings(context),
];

const belowTickMessage = (role: string, remindBefore: number): string =>
  `${role}: remindBefore (${String(remindBefore)} ms) is shorter than the pause timers' tick (${String(PAUSE_TIMERS_EVERY)} ms) — its reminder can be skipped; use at least ${String(PAUSE_TIMERS_EVERY)} ms`;

/** The roles of the workflow's question steps and of its tools' channels, each once. */
function rolesOf(context: AnalysisContext): readonly StoredChannelRole[] {
  const fromQuestions = [...questionExpiriesOf(context.workflow.flow).keys()].flatMap(
    (question) => {
      const role = channelRoleOptionsOf(question);
      return role === undefined ? [] : [role];
    },
  );
  const fromTools = toolsOf(context).flatMap((cls) => {
    const component = componentOf(cls);
    if (component?.kind !== "tool") return [];
    const { channel } = component.meta;
    const role = channel === undefined ? undefined : channelRoleOf(channel)?.options;
    return role === undefined ? [] : [role];
  });
  return [...new Map([...fromQuestions, ...fromTools].map((role) => [role.name, role])).values()];
}

/** `[channel.remind-before-below-tick]` over the roles a workflow's pauses use. */
export const remindBeforeBelowTickWarnings = (context: AnalysisContext): readonly RuleViolation[] =>
  rolesOf(context).flatMap((role) =>
    typeof role.remindBefore === "number" &&
    isRemindBefore(role.remindBefore) &&
    role.remindBefore < PAUSE_TIMERS_EVERY
      ? [
          violation(
            "channel.remind-before-below-tick",
            belowTickMessage(role.name, role.remindBefore),
            [role.name],
          ),
        ]
      : [],
  );
