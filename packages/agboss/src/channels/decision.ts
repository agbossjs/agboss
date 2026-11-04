import { DtoValidationError, pathOf } from "../dto/errors.js";
import { validate } from "../dto/schema.js";
import { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";
import type { UsageRecord } from "../finops/usage.js";
import type { AnyTool } from "../tools/index.js";
import type { DtoClass } from "../dto/types.js";
import { isApprovalPause, type PauseRecord } from "../infrastructure/pause-record.js";

/**
 * A decision on a tool call, validated on the way in (#267 AC7) — from `app.resume` or a channel's
 * `ChannelOutcome.decided(…)`: a `ToolCallApprovalDecisionDto` (`overrideArguments` only with
 * `approved: true`), its `overrideArguments` a valid input of the tool.
 */

/** A validated decision and who gave it, as the agent's loop takes it. */
export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
  readonly overrideArguments?: Readonly<Record<string, unknown>>;
  /** Who answered: the resume's `answeredBy`, the thread's owner, or the channel that decided. */
  readonly by: string;
  /** What reading the reply cost (its interpreter's model calls, #267 PR 3): the step's spend. */
  readonly usage: readonly UsageRecord[];
}

/** The decision, validated, with who gave it and what reading it cost. */
export function approvalDecisionOf(
  decision: unknown,
  tool: AnyTool,
  by: string,
  usage: readonly UsageRecord[],
): ApprovalDecision {
  const { approved, reason, overrideArguments } = validDecisionOf(decision, tool);
  return {
    approved,
    by,
    usage,
    ...(reason === undefined ? {} : { reason }),
    ...(overrideArguments === undefined ? {} : { overrideArguments }),
  };
}

/** The decision as a `ToolCallApprovalDecisionDto`, its `overrideArguments` checked by the tool's input. */
export function validDecisionOf(decision: unknown, tool: AnyTool): ToolCallApprovalDecisionDto {
  const valid = validate(ToolCallApprovalDecisionDto, decision);
  if (valid.overrideArguments === undefined) return valid;
  const checked = tool.input.safeParse(valid.overrideArguments);
  if (checked.success) {
    // strict (#688): a key the tool's input does not have, at any depth, is refused — never dropped
    const dropped = droppedKeysOf(valid.overrideArguments, checked.data, []);
    if (dropped.length > 0)
      throw new DtoValidationError(
        ToolCallApprovalDecisionDto.name,
        dropped.map((path) => ({
          path: pathOf(["overrideArguments", ...path]),
          reason: "is no field of the tool's input",
        })),
      );
    return valid;
  }
  throw new DtoValidationError(
    ToolCallApprovalDecisionDto.name,
    checked.error.issues.map((issue) => ({
      path: pathOf(["overrideArguments", ...issue.path]),
      reason: issue.message,
    })),
  );
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The paths of `raw` the validated `parsed` does not have: keys a schema dropped, at any depth. */
function droppedKeysOf(raw: unknown, parsed: unknown, at: readonly (string | number)[]) {
  const dropped: (readonly (string | number)[])[] = [];
  if (Array.isArray(raw) && Array.isArray(parsed))
    raw.forEach((item, index) =>
      dropped.push(...droppedKeysOf(item, parsed[index], [...at, index])),
    );
  else if (isPlainObject(raw) && isPlainObject(parsed))
    for (const [key, item] of Object.entries(raw))
      if (Object.hasOwn(parsed, key))
        dropped.push(...droppedKeysOf(item, parsed[key], [...at, key]));
      else dropped.push([...at, key]);
  return dropped;
}

/** Where a pause's answer is checked: its tool, or its question's answer DTO (#659). */
export interface AnswerChecks {
  readonly tools: (name: string) => AnyTool;
  readonly questions?: (workflow: string, node: string) => DtoClass | undefined;
}

/**
 * How a pause's answer is validated: a tool call's decision against the tool (#267 AC7); a question
 * role's (#659) as the role's `answer` DTO — a question step's, or the question tool of the agent
 * that asked it (#712), by the role's name on the pause's component.
 */
export function answerValidatorOf(
  pause: PauseRecord,
  checks: AnswerChecks,
): (decision: unknown) => unknown {
  if (isApprovalPause(pause)) {
    const tool = checks.tools(pause.ask.tool);
    return (decision) => validDecisionOf(decision, tool);
  }
  const answer = checks.questions?.(pause.workflow, pause.agent) ?? askedByAgent(pause, checks);
  if (answer === undefined)
    throw new TypeError(`pause ${pause.pauseId}: ${pause.agent} is no question of this tree`);
  return (decision) => validate(answer, decision);
}

/** The answer of a question role an agent asked through its tool loop (#712): its tool's. */
function askedByAgent(pause: PauseRecord, checks: AnswerChecks): DtoClass | undefined {
  const role = pause.component?.name;
  return role === undefined ? undefined : checks.tools(role).question?.answer;
}
