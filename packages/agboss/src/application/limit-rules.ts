import { violation, type RuleViolation } from "../graph/rule-error.js";
import { MAX_TIMEOUT, timerProblemOf } from "../units/timer-limits.js";
import { providerTimeoutViolations } from "../models/provider-mode-rules.js";
import type { ApplicationOptions } from "./application.js";

/**
 * `shutdownTimeout` and `compensationTimeout` bound a timer: above `MAX_TIMEOUT` (24 hours) Node
 * would fire it at once (#1141), a shutdown that gives up and an undo that times out immediately.
 */
function timerSettingViolations(options: ApplicationOptions): RuleViolation[] {
  const fields = [
    ["executionLimits.shutdownTimeout", options.executionLimits?.shutdownTimeout],
    ["executionLimits.compensationTimeout", options.executionLimits?.compensationTimeout],
    ["executionLimits.childClaimTimeout", options.executionLimits?.childClaimTimeout],
  ] as const;
  return fields.flatMap(([field, value]) => {
    const problem = value === undefined ? undefined : timerProblemOf(field, value, MAX_TIMEOUT);
    return problem === undefined
      ? []
      : [violation("limits.timeout-invalid", `its ${problem}`, [options.name])];
  });
}

/** `maxConcurrentSteps` is a whole number of steps from 1 (#332): 0 would stop the instance. */
function stepCapViolations(options: ApplicationOptions): RuleViolation[] {
  const value = options.executionLimits?.maxConcurrentSteps;
  if (value === undefined || (Number.isInteger(value) && value >= 1)) return [];
  const message =
    `its executionLimits.maxConcurrentSteps is ${String(value)}, not a whole number of steps from 1 — ` +
    "@Application({ executionLimits: { maxConcurrentSteps: 32 } }) lets 32 steps of this instance work at once";
  return [violation("limits.max-concurrent-steps-invalid", message, [options.name])];
}

/** The application's limits: its caps, its timers (#1141) and its providers' timeouts. */
export const limitViolations = (options: ApplicationOptions): RuleViolation[] => [
  ...stepCapViolations(options),
  ...timerSettingViolations(options),
  ...providerTimeoutViolations(options.name, [
    ...(options.providers ?? []),
    ...(options.modelProvider === undefined ? [] : [options.modelProvider]),
  ]),
];
