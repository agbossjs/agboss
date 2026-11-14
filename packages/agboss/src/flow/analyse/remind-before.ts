import { channelRoleOf, channelRoleOptionsOf } from "../../channels/channel-role.decorator.js";
import { isExpiresIn, isRemindBefore } from "../../channels/channel-rules.js";
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
 */

/** Whether the pause's `expiresIn` leaves no room for the role's reminder. */
const leavesNoRoom = (expiresIn: unknown, remindBefore: unknown): boolean =>
  isExpiresIn(expiresIn) && isRemindBefore(remindBefore) && expiresIn <= remindBefore;

const message = (owner: string, expiresIn: number, role: string, remindBefore: number): string =>
  `${owner}: expiresIn (${String(expiresIn)} ms) is not longer than ${role}'s remindBefore (${String(remindBefore)} ms) — its pauses get no reminder`;

/** The question steps whose `expiresIn` leaves no room for their role's reminder. */
function questionWarnings(context: AnalysisContext): RuleViolation[] {
  const expiries = questionExpiriesOf(context.workflow.flow);
  return [...expiries.keys()].flatMap((question) => {
    const role = channelRoleOptionsOf(question);
    const expiresIn = expiresInOfQuestion(expiries, question);
    if (role === undefined || !leavesNoRoom(expiresIn, role.remindBefore)) return [];
    const text = message(role.name, Number(expiresIn), "its role", Number(role.remindBefore));
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
    if (component?.kind !== "tool" && component?.kind !== "mcp-tool") return [];
    const { name, channel, expiresIn } = component.meta;
    const role = channel === undefined ? undefined : channelRoleOf(channel)?.options;
    if (role === undefined || !leavesNoRoom(expiresIn, role.remindBefore)) return [];
    const text = message(name, Number(expiresIn), role.name, Number(role.remindBefore));
    return [violation("channel.remind-before-exceeds-expiry", text, [name])];
  });
}

/** `[channel.remind-before-exceeds-expiry]` over a workflow's question steps and tools. */
export const remindBeforeWarnings = (context: AnalysisContext): readonly RuleViolation[] => [
  ...questionWarnings(context),
  ...toolWarnings(context),
];
