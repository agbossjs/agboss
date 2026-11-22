/**
 * #1366: the limits of an `@Application` called directly — a step cap and a hop cap that are no whole number from 1,
 * a timer above its maximum (the message names the field and the value), and the providers' timeouts. The shard
 * `assembly-rules` mutates `limit-rules.ts` whole.
 */
import { describe, expect, it } from "vitest";
import type { ApplicationOptions } from "../../src/application/application.js";
import { limitViolations } from "../../src/application/limit-rules.js";
import { EmptyEnvironment } from "../../src/index.js";
import { MAX_TIMEOUT, timerProblemOf } from "../../src/units/timer-limits.js";
import type { Milliseconds } from "../../src/units/index.js";

const NAME = "limited-application";
const options = (rest: Partial<ApplicationOptions>): ApplicationOptions => ({
  name: NAME,
  version: "1.0.0",
  environment: EmptyEnvironment,
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
          maxConcurrentSteps: 1,
          maxMeshHops: 1,
          shutdownTimeout: MAX_TIMEOUT,
          compensationTimeout: MAX_TIMEOUT,
        }),
      ),
    ).toEqual([]);
  });

  it("names a step cap that is no whole number of steps from 1", () => {
    for (const value of [0, -3, 2.5, Number.NaN]) {
      expect(limitViolations(options({ maxConcurrentSteps: value }))).toEqual([
        {
          code: "limits.max-concurrent-steps-invalid",
          message: `its maxConcurrentSteps is ${String(value)}, not a whole number of steps from 1 — @Application({ maxConcurrentSteps: 32 }) lets 32 steps of this instance work at once`,
          nodes: [NAME],
        },
      ]);
    }
  });

  it("names a hop cap that is no whole number of applications from 1", () => {
    for (const value of [0, -1, 1.5]) {
      expect(limitViolations(options({ maxMeshHops: value }))).toEqual([
        {
          code: "limits.max-mesh-hops-invalid",
          message: `its maxMeshHops is ${String(value)}, not a whole number of applications from 1 — @Application({ maxMeshHops: 6 }) refuses a call chain that already passed through 6 applications`,
          nodes: [NAME],
        },
      ]);
    }
  });

  it("names the shutdown and the compensation timeout above the maximum, each by its field", () => {
    const shutdown = timerProblemOf("shutdownTimeout", over, MAX_TIMEOUT);
    const compensation = timerProblemOf("compensationTimeout", over, MAX_TIMEOUT);

    expect(limitViolations(options({ shutdownTimeout: over, compensationTimeout: over }))).toEqual([
      { code: "limits.timeout-invalid", message: `its ${String(shutdown)}`, nodes: [NAME] },
      { code: "limits.timeout-invalid", message: `its ${String(compensation)}`, nodes: [NAME] },
    ]);
    expect(String(shutdown)).toContain("shutdownTimeout");
  });
});
