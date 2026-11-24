/** A target's `@ChannelInterpreter` on its own, as assembly finds it (`testReplyInterpreter`, #644). */
import { isExternalTask, type FoundPauseTarget } from "./pause-targets.js";
import { ToolCallApprovalAskDto } from "../dto/standard/framework.js";
import type { PromptLoader } from "../components/prompt-render.js";
import type { RuleViolation } from "../graph/rule-error.js";
import {
  assembledOf,
  interpretedTargetsOf,
  replyInterpreterViolations,
  type AssembledReplyInterpreter,
} from "./discovery.js";

/** A target's interpreter as assembly finds it, and what its rules say of it. */
export interface TargetInterpreterFound {
  /** `undefined` when the target names none, or an undecorated one. */
  readonly interpreter: AssembledReplyInterpreter | undefined;
  readonly violations: readonly RuleViolation[];
}

/**
 * A target's interpreter on its own (`testReplyInterpreter`, #644): its rules checked as at assembly
 * — `undefined` when the target names none (or an undecorated one, which the violations name).
 */
export async function targetInterpreterOf(
  target: FoundPauseTarget,
  loader: PromptLoader,
): Promise<TargetInterpreterFound> {
  const { options } = target;
  // a tool approval with no `input` approves any tool: no input to name
  const toolInput = isExternalTask(options)
    ? options.input
    : (options.input ?? ToolCallApprovalAskDto);
  const use = { tool: options.name, toolInput, target: target.target, workflow: "" };
  const violations = replyInterpreterViolations([use]);
  const [found] = interpretedTargetsOf([use]);
  return {
    interpreter: found === undefined ? undefined : await assembledOf(found, loader),
    violations,
  };
}
