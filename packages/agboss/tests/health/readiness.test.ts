/**
 * #300 AC2 / AC3: `app.checkReadiness()` — liveness's components, every store's `ping()`, every
 * model provider's circuit breaker (open → `Degraded`) and every `@Application({ healthChecks })`
 * check, each under its timeout on the `Clock`. A store or a check that throws or times out is
 * `Unhealthy`, named, with its reason; the call still resolves. No check calls a model.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { HealthComponentKind, HealthStatus, type HealthReport } from "../../src/index.js";
import { circuitOpenKeyOf } from "../../src/models/circuit-breaker.js";
import { testWith } from "../../src/testing/index.js";
import { minutes, seconds } from "../../src/units/index.js";
import {
  CrmClient,
  levers,
  PlainProbeApplication,
  ProbeAgent,
  ProbeApplication,
  resetHealth,
  stores,
} from "./fixtures/health.application.js";

const test = testWith(ProbeApplication);
const plain = testWith(PlainProbeApplication);

beforeEach(resetHealth);
afterEach(resetHealth);

/** The report's component of this name. */
const componentOf = (report: HealthReport, name: string): HealthReport["components"][number] => {
  const found = report.components.find((component) => component.name === name);
  if (found === undefined) throw new Error(`the report has no component ${name}`);
  return found;
};

describe("#300 AC2: readiness", () => {
  plain("a ready instance: every store and model provider healthy, by kind", async ({ app }) => {
    const report = await app.checkReadiness();

    expect(report.status).toBe(HealthStatus.Healthy);
    expect(report.components.map(({ name, kind, status }) => ({ name, kind, status }))).toEqual([
      { name: "plain-probe-application", kind: HealthComponentKind.Application, status: "healthy" },
      { name: "recovery-loop", kind: HealthComponentKind.RecoveryLoop, status: "healthy" },
      {
        name: "StallingExecutionRecordRepository",
        kind: HealthComponentKind.Store,
        status: "healthy",
      },
      { name: "FlakyCostLedgerRepository", kind: HealthComponentKind.Store, status: "healthy" },
      {
        name: "InMemoryPausedExecutionRepository",
        kind: HealthComponentKind.Store,
        status: "healthy",
      },
      {
        name: "InMemoryExecutionLeaseRepository",
        kind: HealthComponentKind.Store,
        status: "healthy",
      },
      {
        name: "InMemoryExecutionTreeRepository",
        kind: HealthComponentKind.Store,
        status: "healthy",
      },
      { name: "ReachableRateLimitRepository", kind: HealthComponentKind.Store, status: "healthy" },
      { name: "InMemoryMeshRequestRepository", kind: HealthComponentKind.Store, status: "healthy" },
      {
        name: "InMemoryExecutionHistoryRepository",
        kind: HealthComponentKind.Store,
        status: "healthy",
      },
      {
        name: "InMemoryExecutionLeaseEventRepository", // #501
        kind: HealthComponentKind.Store,
        status: "healthy",
      },
      { name: "SharedCheckpointSaver", kind: HealthComponentKind.Store, status: "healthy" },
      {
        name: "openrouter-model-provider",
        kind: HealthComponentKind.ModelProvider,
        status: "healthy",
      },
      {
        name: "decisions-model-provider",
        kind: HealthComponentKind.ModelProvider,
        status: "healthy",
      },
    ]);
  });

  plain(
    "an unreachable store makes it unhealthy, the store named with its error",
    async ({ app }) => {
      levers.isLedgerDown = true;

      const report = await app.checkReadiness();

      expect(report.status).toBe(HealthStatus.Unhealthy);
      expect(componentOf(report, "FlakyCostLedgerRepository")).toMatchObject({
        kind: HealthComponentKind.Store,
        status: HealthStatus.Unhealthy,
        reason: "connection refused",
      });
    },
  );

  plain(
    "an open breaker of a model provider makes it degraded, never unhealthy",
    async ({ app, clock }) => {
      await app.ready();
      const until = new Date(clock.now().getTime() + minutes(1));
      await stores.rateLimits?.pauseUntil(circuitOpenKeyOf("openrouter-model-provider"), until);

      const report = await app.checkReadiness();

      expect(report.status).toBe(HealthStatus.Degraded);
      expect(componentOf(report, "openrouter-model-provider")).toMatchObject({
        kind: HealthComponentKind.ModelProvider,
        status: HealthStatus.Degraded,
        reason: `circuit breaker open until ${until.toISOString()}`,
      });
      expect(componentOf(report, "decisions-model-provider").status).toBe(HealthStatus.Healthy);
    },
  );

  test("the project's checks are named in the breakdown with their own results", async ({
    app,
  }) => {
    const report = await app.checkReadiness();

    expect(report.status).toBe(HealthStatus.Degraded);
    expect(componentOf(report, "crm-health-check")).toMatchObject({
      kind: HealthComponentKind.Project,
      status: HealthStatus.Healthy,
    });
    expect(componentOf(report, "search-health-check")).toMatchObject({
      kind: HealthComponentKind.Project,
      status: HealthStatus.Degraded,
      reason: "a replica is down",
    });
  });

  test("a failing project check is unhealthy with its reason", async ({ app, mockOf }) => {
    mockOf(CrmClient).ping.mockResolvedValue(false);

    const report = await app.checkReadiness();

    expect(report.status).toBe(HealthStatus.Unhealthy);
    expect(componentOf(report, "crm-health-check")).toMatchObject({
      status: HealthStatus.Unhealthy,
      reason: "CRM is unreachable",
    });
  });

  test("a project check that throws is unhealthy with the error's message; the call resolves", async ({
    app,
    mockOf,
  }) => {
    mockOf(CrmClient).ping.mockRejectedValue(new Error("CRM answered 503"));

    const report = await app.checkReadiness();

    expect(componentOf(report, "crm-health-check")).toMatchObject({
      status: HealthStatus.Unhealthy,
      reason: "CRM answered 503",
    });
  });

  test("a project check past its timeout counts as failed: timed out", async ({
    app,
    clock,
    mockOf,
  }) => {
    mockOf(CrmClient).ping.mockImplementation(() => clock.sleep(seconds(5)).then(() => true));
    await app.ready();

    const pending = app.checkReadiness();
    await clock.advance(seconds(3));
    const report = await pending;

    expect(report.status).toBe(HealthStatus.Unhealthy);
    expect(componentOf(report, "crm-health-check")).toMatchObject({
      status: HealthStatus.Unhealthy,
      reason: "timed out after 2 s",
    });
    expect(componentOf(report, "crm-health-check").duration).toBeGreaterThanOrEqual(seconds(2));
  });
});

describe("#300 AC3: no check calls a model", () => {
  test("readiness reads the breakers from the store: the scripted models see no call", async ({
    app,
    mockLlm,
  }) => {
    await app.checkReadiness();
    await app.checkLiveness();

    expect(mockLlm(ProbeAgent)).toHaveBeenCalledTimes(0);
  });
});
