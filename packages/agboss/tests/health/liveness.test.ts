/**
 * #300 AC1: `app.checkLiveness()` — no network, no database: the instance (`Unhealthy`, `stopping`,
 * from `close()` on) and its recovery loop (`Unhealthy` when its last sweep ended more than three
 * sweep intervals ago on the `Clock`). It never rejects.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { HealthComponentKind, HealthStatus } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { levers, PlainProbeApplication, resetHealth } from "./fixtures/health.application.js";

const test = testWith(PlainProbeApplication);

beforeEach(resetHealth);
afterEach(resetHealth);

describe("#300 AC1: liveness", () => {
  test("a running instance is alive: the application and its recovery loop, each healthy", async ({
    app,
  }) => {
    const report = await app.checkLiveness();

    expect(report).toEqual({
      status: HealthStatus.Healthy,
      components: [
        {
          name: "plain-probe-application",
          kind: HealthComponentKind.Application,
          status: HealthStatus.Healthy,
          duration: 0,
        },
        {
          name: "recovery-loop",
          kind: HealthComponentKind.RecoveryLoop,
          status: HealthStatus.Healthy,
          duration: 0,
        },
      ],
    });
  });

  test("from close() on the instance is unhealthy: stopping", async ({ app }) => {
    await app.ready();

    const closing = app.close();
    const report = await app.checkLiveness();
    await closing;

    expect(report.status).toBe(HealthStatus.Unhealthy);
    expect(report.components).toContainEqual(
      expect.objectContaining({
        kind: HealthComponentKind.Application,
        status: HealthStatus.Unhealthy,
        reason: "stopping",
      }),
    );
  });

  test("a recovery loop that keeps sweeping stays healthy as time passes", async ({
    app,
    clock,
  }) => {
    await app.ready();

    await clock.advance(seconds(91));

    expect((await app.checkLiveness()).status).toBe(HealthStatus.Healthy);
  });

  test("a recovery loop stuck in its look-up past three intervals is unhealthy", async ({
    app,
    clock,
  }) => {
    levers.isSweepStuck = true;
    await app.ready();
    await clock.advance(seconds(90));
    const inTime = await app.checkLiveness();

    await clock.advance(seconds(1));
    const stuck = await app.checkLiveness();

    expect(inTime.status).toBe(HealthStatus.Healthy);
    expect(stuck.status).toBe(HealthStatus.Unhealthy);
    expect(stuck.components).toContainEqual(
      expect.objectContaining({
        name: "recovery-loop",
        status: HealthStatus.Unhealthy,
        reason: "stuck: its last sweep ended 91 s ago (more than 90 s)",
      }),
    );
  });
});
