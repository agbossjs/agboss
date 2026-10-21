/**
 * #300: the assembly rules of `@Application({ healthChecks })` — every listed class is a
 * `@HealthCheck` (`[health.not-a-health-check]`), its name ends with `-health-check`
 * (`[name.kind-suffix]`) and is unique (`[health.duplicate-name]`) — all at once, before any model
 * call; and a `HealthCheckResult` is built only by its builders.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import {
  EmptyEnvironment,
  GraphRuleError,
  HealthCheck,
  HealthCheckResult,
  HealthStatus,
  nameOf,
  type HealthCheckHandler,
} from "../../src/index.js";
import { seconds } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { CrmClient, ProbeWorkflow } from "./fixtures/health.application.js";

/** The codes and messages an application's assembly fails with. */
async function violationsOf(application: Class): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError))
    throw new Error(`expected a GraphRuleError: ${String(error)}`);
  return error.violations.map((found) => `[${found.code}] ${found.message}`);
}

@HealthCheck({ name: "queue-health-check", timeout: seconds(1) })
class QueueHealthCheck implements HealthCheckHandler {
  check(): Promise<HealthCheckResult> {
    return Promise.resolve(HealthCheckResult.healthy());
  }
}

@HealthCheck({ name: "queue-health-check", timeout: seconds(1) })
class SecondQueueHealthCheck implements HealthCheckHandler {
  check(): Promise<HealthCheckResult> {
    return Promise.resolve(HealthCheckResult.healthy());
  }
}

@HealthCheck({ name: "queue-probe", timeout: seconds(1) })
class MisnamedHealthCheck implements HealthCheckHandler {
  check(): Promise<HealthCheckResult> {
    return Promise.resolve(HealthCheckResult.healthy());
  }
}

/** Has the method, not the decorator. */
class UndecoratedHealthCheck implements HealthCheckHandler {
  check(): Promise<HealthCheckResult> {
    return Promise.resolve(HealthCheckResult.healthy());
  }
}

@Application({
  name: "checked-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ProbeWorkflow],
  budgets: TEST_BUDGETS,
  healthChecks: [
    QueueHealthCheck,
    SecondQueueHealthCheck,
    MisnamedHealthCheck,
    UndecoratedHealthCheck,
  ],
})
class CheckedApplication {}

describe("#300: the health checks' assembly rules", () => {
  it("fails with every violation at once: undecorated, misnamed, a name twice", async () => {
    expect(await violationsOf(CheckedApplication)).toEqual([
      '[name.kind-suffix] "queue-probe" on @HealthCheck — name it "queue-probe-health-check"',
      "[health.not-a-health-check] UndecoratedHealthCheck in checked-application's healthChecks has no @HealthCheck({ name, timeout }) decorator",
      '[health.duplicate-name] "queue-health-check" names QueueHealthCheck and SecondQueueHealthCheck in checked-application\'s healthChecks — give each its own name',
    ]);
  });

  it("deps are checked against the constructor (compile time)", () => {
    // @ts-expect-error — the constructor needs a CrmClient, `deps` names none
    @HealthCheck({ name: "crm-without-deps-health-check", timeout: seconds(1) })
    class CrmWithoutDepsHealthCheck implements HealthCheckHandler {
      constructor(private readonly crmClient: CrmClient) {}

      async check(): Promise<HealthCheckResult> {
        return (await this.crmClient.ping())
          ? HealthCheckResult.healthy()
          : HealthCheckResult.unhealthy({ reason: "down" });
      }
    }

    expect(nameOf(CrmWithoutDepsHealthCheck)).toBe("crm-without-deps-health-check");
  });

  it("nameOf reads a health check's name", () => {
    expect(nameOf(QueueHealthCheck)).toBe("queue-health-check");
  });
});

describe("#300: HealthCheckResult", () => {
  it("is built frozen by its builders: healthy, degraded and unhealthy with a reason", () => {
    const degraded = HealthCheckResult.degraded({ reason: "slow" });

    expect(HealthCheckResult.healthy()).toEqual({ status: HealthStatus.Healthy });
    expect(degraded).toEqual({ status: HealthStatus.Degraded, reason: "slow" });
    expect(HealthCheckResult.unhealthy({ reason: "down" })).toEqual({
      status: HealthStatus.Unhealthy,
      reason: "down",
    });
    expect(Object.isFrozen(degraded)).toBe(true);
  });

  it("a plain object is not a result (compile time)", () => {
    // @ts-expect-error — a result is built only with HealthCheckResult.healthy() / …
    const plainObject: HealthCheckResult = { status: HealthStatus.Healthy };

    expect(plainObject.status).toBe(HealthStatus.Healthy);
  });
});
