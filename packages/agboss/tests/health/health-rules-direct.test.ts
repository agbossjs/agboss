/**
 * #1366: the rules of `@Application({ healthChecks })`, called directly: each violation's code, exact message and node,
 * a timeout above its maximum, duplicates by name, what a decorator records (the deps default to none) and which
 * listed classes the container creates. The shard `assembly-rules` mutates `health-check.ts` whole.
 */
import { describe, expect, it } from "vitest";
import {
  decoratedHealthChecksOf,
  HealthCheck,
  healthCheckOf,
  healthCheckRuleViolations,
  HealthCheckResult,
  type HealthCheckHandler,
} from "../../src/health/health-check.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";
import { MAX_TIMEOUT, timerProblemOf } from "../../src/units/timer-limits.js";

class Handler implements HealthCheckHandler {
  check(): Promise<HealthCheckResult> {
    return Promise.resolve(HealthCheckResult.healthy());
  }
}

@HealthCheck({ name: "queue-health-check", timeout: seconds(1) })
class QueueCheck extends Handler {}

@HealthCheck({ name: "queue-health-check", timeout: seconds(1) })
class OtherQueueCheck extends Handler {}

@HealthCheck({ name: "third-health-check", timeout: seconds(1) })
class ThirdCheck extends Handler {}

@HealthCheck({ name: "Queue_Probe", timeout: seconds(1) })
class MisnamedCheck extends Handler {}

const over = (MAX_TIMEOUT + 1) as Milliseconds;

@HealthCheck({ name: "slow-health-check", timeout: over })
class SlowCheck extends Handler {}

class Undecorated extends Handler {}

const APP = "probed-application";
const found = (healthChecks?: readonly (new () => HealthCheckHandler)[]) =>
  healthCheckRuleViolations({
    name: APP,
    ...(healthChecks === undefined ? {} : { healthChecks }),
  }).map(({ code, message, nodes }) => ({ code, message, nodes }));

describe("#1366: healthCheckRuleViolations", () => {
  it("finds nothing in a good list, an empty one or none", () => {
    expect(found([QueueCheck, ThirdCheck])).toEqual([]);
    expect(found([])).toEqual([]);
    expect(found()).toEqual([]);
  });

  it("names a class that is no health check, and a name without its kind", () => {
    expect(found([Undecorated, MisnamedCheck])).toEqual([
      {
        code: "health.not-a-health-check",
        message: `Undecorated in ${APP}'s healthChecks has no @HealthCheck({ name, timeout }) decorator`,
        nodes: [APP],
      },
      {
        code: "name.not-kebab-case",
        message: '"Queue_Probe" on @HealthCheck — a name is kebab-case: "queue-probe"',
        nodes: [APP],
      },
    ]);
  });

  it("names a timeout above the maximum, by the check", () => {
    expect(found([SlowCheck])).toEqual([
      {
        code: "limits.timeout-invalid",
        message: `slow-health-check: ${String(timerProblemOf("timeout", over, MAX_TIMEOUT))}`,
        nodes: [APP],
      },
    ]);
  });

  it("names two checks of one name, once, and not a name of one", () => {
    expect(found([QueueCheck, ThirdCheck, OtherQueueCheck])).toEqual([
      {
        code: "health.duplicate-name",
        message: `"queue-health-check" names QueueCheck and OtherQueueCheck in ${APP}'s healthChecks — give each its own name`,
        nodes: [APP],
      },
    ]);
  });

  it("reads a class that is no health check as having no name to clash", () => {
    expect(found([Undecorated, Undecorated]).map((one) => one.code)).toEqual([
      "health.not-a-health-check",
      "health.not-a-health-check",
    ]);
  });
});

describe("#1366: what a health check records and which the container creates", () => {
  it("records its name, timeout and deps, none by default", () => {
    expect(healthCheckOf(QueueCheck)).toEqual({
      name: "queue-health-check",
      timeout: seconds(1),
      deps: [],
    });
    expect(healthCheckOf(Undecorated)).toBeUndefined();
  });

  it("creates the decorated classes of a list, in order, and none for none", () => {
    expect(decoratedHealthChecksOf([QueueCheck, Undecorated, ThirdCheck])).toEqual([
      QueueCheck,
      ThirdCheck,
    ]);
    expect(decoratedHealthChecksOf([Undecorated])).toEqual([]);
    expect(decoratedHealthChecksOf([])).toEqual([]);
  });

  it("names an anonymous class", () => {
    const anonymous = (() => class extends Handler {})();
    Object.defineProperty(anonymous, "name", { value: "" });

    expect(found([anonymous])[0]?.message).toContain("(anonymous class) in probed-application");
  });
});
