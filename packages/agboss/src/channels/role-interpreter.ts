/** A role's `@ReplyInterpreter` on its own, as assembly finds it (`testReplyInterpreter`, #644). */
import { isQuestionRole, type FoundChannelRole } from "./channel-role.decorator.js";
import type { PromptLoader } from "../components/prompt-render.js";
import type { RuleViolation } from "../graph/rule-error.js";
import {
  assembledOf,
  interpretedRolesOf,
  replyInterpreterViolations,
  type AssembledReplyInterpreter,
} from "./discovery.js";

/** A role's interpreter as assembly finds it, and what its rules say of it. */
export interface RoleInterpreterFound {
  /** `undefined` when the role names none, or an undecorated one. */
  readonly interpreter: AssembledReplyInterpreter | undefined;
  readonly violations: readonly RuleViolation[];
}

/**
 * A role's interpreter on its own (`testReplyInterpreter`, #644): its rules checked as at assembly
 * — `undefined` when the role names none (or an undecorated one, which the violations name).
 */
export async function roleInterpreterOf(
  role: FoundChannelRole,
  loader: PromptLoader,
): Promise<RoleInterpreterFound> {
  const { options } = role;
  const toolInput = isQuestionRole(options) ? options.ask : options.approves;
  const use = { tool: options.name, toolInput, channel: role.role, workflow: "" };
  const violations = replyInterpreterViolations([use]);
  const [found] = interpretedRolesOf([use]);
  return {
    interpreter: found === undefined ? undefined : await assembledOf(found, loader),
    violations,
  };
}
