/**
 * #1343: `@HealthCheck()` takes optional options (the name from the class, `timeout` 5 s), `check`
 * may be sync and gets a context whose `signal` aborts at the timeout; `unhealthy(reason)` /
 * `degraded(reason)` take the reason itself; `HealthReport` has `isBusy`, `isAlive`, `isReady`.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Application } from "../../src/application/application.js";
import {
  EmptyEnvironment,
  HealthCheck,
  HealthCheckResult,
  HealthStatus,
  type HealthCheckContext,
} from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { ProbeWorkflow, resetHealth } from "./fixtures/health.application.js";

const seen: string[] = [];

/** No options at all: named after its class, synchronous. */
@HealthCheck()
class BareHealthCheck {
  check(): HealthCheckResult {
    return HealthCheckResult.degraded("running on a replica");
  }
}

/** Waits for its signal: the timeout aborts it. */
@HealthCheck({ name: "waiting-health-check" })
class WaitingHealthCheck {
  check(ctx: HealthCheckContext): Promise<HealthCheckResult> {
    return new Promise((resolve) => {
      ctx.signal.addEventListener(
        "abort",
        () => {
          seen.push("aborted");
          resolve(HealthCheckResult.healthy());
        },
        { once: true },
      );
    });
  }
}

@Application({
  name: "options-probe-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ProbeWorkflow],
  budgets: TEST_BUDGETS,
  healthChecks: [WaitingHealthCheck],
})
class WaitingProbeApplication {}

@Application({
  name: "bare-probe-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ProbeWorkflow],
  budgets: TEST_BUDGETS,
  healthChecks: [BareHealthCheck],
})
class BareProbeApplication {}

const waiting = testWith(WaitingProbeApplication);
const bare = testWith(BareProbeApplication);

beforeEach(() => {
  seen.length = 0;
  resetHealth();
});
afterEach(resetHealth);

describe("@HealthCheck options", () => {
  bare(
    "a sync check with no options is named after its class and degrades the report",
    async ({ app }) => {
      await app.ready();

      const report = await app.checkReadiness();

      expect(
        report.components.find((component) => component.name === "bare-health-check"),
      ).toMatchObject({
        status: HealthStatus.Degraded,
        reason: "running on a replica",
      });
      // a Degraded instance is alive and ready
      expect(report).toMatchObject({ isAlive: true, isReady: true, isBusy: false });
    },
  );

  waiting(
    "the default timeout is 5 s and aborts the signal the check was given",
    async ({ app, clock }) => {
      await app.ready();

      const pending = app.checkReadiness();
      await clock.advance(seconds(4));
      expect(seen).toEqual([]);
      await clock.advance(seconds(2));
      const report = await pending;

      expect(seen).toEqual(["aborted"]);
      expect(
        report.components.find((component) => component.name === "waiting-health-check"),
      ).toMatchObject({
        status: HealthStatus.Unhealthy,
        reason: "timed out after 5 s",
      });
      expect(report).toMatchObject({
        status: HealthStatus.Unhealthy,
        isAlive: false,
        isReady: false,
      });
    },
  );
});
