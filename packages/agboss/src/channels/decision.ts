import { DtoValidationError, pathOf } from "../dto/errors.js";
import { validate } from "../dto/schema.js";
import { ToolCallApprovalDecisionDto } from "../dto/standard/framework.js";
import type { UsageRecord } from "../finops/usage.js";
import type { AnyTool } from "../tools/index.js";

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
  if (checked.success) return valid;
  throw new DtoValidationError(
    ToolCallApprovalDecisionDto.name,
    checked.error.issues.map((issue) => ({
      path: pathOf(["overrideArguments", ...issue.path]),
      reason: issue.message,
    })),
  );
}
