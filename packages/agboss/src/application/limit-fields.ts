import { COMPENSATION_TIMEOUT } from "../flow/compensation.js";
import { seconds, type Milliseconds } from "../units/index.js";
import type { ApplicationOptions } from "./application.js";

/** The default of how long a stop waits for the running executions (#265). */
const SHUTDOWN_TIMEOUT: Milliseconds = seconds(25);

/** What `@Application({ executionLimits })` leaves of the instance's limits, as the assembled application keeps them. */
export function limitFieldsOf(options: ApplicationOptions): {
  readonly shutdownTimeout: Milliseconds;
  readonly compensationTimeout: Milliseconds;
  readonly maxConcurrentSteps?: number;
} {
  const limits = options.executionLimits;
  return {
    shutdownTimeout: limits?.shutdownTimeout ?? SHUTDOWN_TIMEOUT,
    compensationTimeout: limits?.compensationTimeout ?? COMPENSATION_TIMEOUT,
    ...(limits?.maxConcurrentSteps === undefined
      ? {}
      : { maxConcurrentSteps: limits.maxConcurrentSteps }),
  };
}
