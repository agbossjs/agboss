/**
 * #1366: the limits of an `@Application` called directly — a step cap and a hop cap that are no whole number from 1,
 * a timer above its maximum (the message names the field and the value), and the providers' timeouts. The shard
 * `assembly-rules` mutates `limit-rules.ts` whole.
 */
import { describe, expect, it } from "vitest";
import type { ApplicationOptions } from "../../src/application/application.js";
import { limitViolations } from "../../src/application/limit-rules.js";
import { MAX_TIMEOUT, timerProblemOf } from "../../src/units/timer-limits.js";
import type { Milliseconds } from "../../src/units/index.js";

const NAME = "limited-application";
const options = (rest: Partial<ApplicationOptions>): ApplicationOptions => ({
  name: NAME,
  version: "1.0.0",
  workflows: [],
  ...rest,
});
const over = (MAX_TIMEOUT + 1) as Milliseconds;

describe("#1366: limitViolations", () => {
  it("finds nothing when no limit is set, or each is within its range", () => {
    expect(limitViolations(options({}))).toEqual([]);
    expect(
      limitViolations(
        options({
          executionLimits: {
            maxConcurrentSteps: 1,
            shutdownTimeout: MAX_TIMEOUT,
            compensationTimeout: MAX_TIMEOUT,
          },
        }),
      ),
    ).toEqual([]);
  });

  it("names a step cap that is no whole number of steps from 1", () => {
    for (const value of [0, -3, 2.5, Number.NaN]) {
      expect(limitViolations(options({ executionLimits: { maxConcurrentSteps: value } }))).toEqual([
        {
          code: "limits.max-concurrent-steps-invalid",
          message: `its executionLimits.maxConcurrentSteps is ${String(value)}, not a whole number of steps from 1 — @Application({ executionLimits: { maxConcurrentSteps: 32 } }) lets 32 steps of this instance work at once`,
          nodes: [NAME],
        },
      ]);
    }
  });

  it("names the shutdown and the compensation timeout above the maximum, each by its field", () => {
    const shutdown = timerProblemOf("executionLimits.shutdownTimeout", over, MAX_TIMEOUT);
    const compensation = timerProblemOf("executionLimits.compensationTimeout", over, MAX_TIMEOUT);

    expect(
      limitViolations(
        options({ executionLimits: { shutdownTimeout: over, compensationTimeout: over } }),
      ),
    ).toEqual([
      { code: "limits.timeout-invalid", message: `its ${String(shutdown)}`, nodes: [NAME] },
      { code: "limits.timeout-invalid", message: `its ${String(compensation)}`, nodes: [NAME] },
    ]);
    expect(String(shutdown)).toContain("executionLimits.shutdownTimeout");
  });
});
