import { violation, type RuleViolation } from "../graph/rule-error.js";
import { MAX_TIMEOUT, timerProblemOf } from "../units/timer-limits.js";
import type { ApplicationOptions } from "./application.js";

/**
 * `shutdownTimeout` and `compensationTimeout` bound a timer: above `MAX_TIMEOUT` (24 hours) Node
 * would fire it at once (#1141), a shutdown that gives up and an undo that times out immediately.
 */
export function timerSettingViolations(options: ApplicationOptions): RuleViolation[] {
  const fields = [
    ["shutdownTimeout", options.shutdownTimeout],
    ["compensationTimeout", options.compensationTimeout],
  ] as const;
  return fields.flatMap(([field, value]) => {
    const problem = value === undefined ? undefined : timerProblemOf(field, value, MAX_TIMEOUT);
    return problem === undefined
      ? []
      : [violation("limits.timeout-invalid", `its ${problem}`, [options.name])];
  });
}
