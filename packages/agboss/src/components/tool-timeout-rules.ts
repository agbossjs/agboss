import { violation, type RuleViolation } from "../graph/rule-error.js";
import { MAX_TIMEOUT, timerProblemOf } from "../units/timer-limits.js";
import { componentOf } from "./metadata.js";
import { tokenName } from "./injection.js";
import type { ToolClasses } from "./assemble-checks.js";

/** `[limits.timeout-invalid]` (#1141): a tool's `timeout` above its maximum would fire at once. */
export function toolTimeoutViolations(tools: ToolClasses): RuleViolation[] {
  return tools.local.flatMap((cls) => {
    const component = componentOf(cls);
    if (component?.kind !== "tool") return [];
    const { name, timeout } = component.meta;
    const problem =
      timeout === undefined ? undefined : timerProblemOf("timeout", timeout, MAX_TIMEOUT);
    return problem === undefined
      ? []
      : [violation("limits.timeout-invalid", `${tokenName(cls)} (${name}): ${problem}`, [name])];
  });
}
