import { describe, expect } from "vitest";
import { HealthStatus } from "@agboss/core";
import { testWith } from "@agboss/core/testing";
import { OrderDeskService } from "../../../src/desk/services/order-desk.service.js";
import { FlowPatternsApplication } from "../../../src/flow-patterns.application.js";

/** The desk's readiness: its health check, and whether the instance is busy (#1343: `isBusy` replaces the step-slots component). */

const test = testWith(FlowPatternsApplication);

describe("readiness: the order system's health check and the busy flag", () => {
  test("healthy when the order system answers", async ({ app }) => {
    const report = await app.checkReadiness();

    const byName = new Map(
      report.components.map((component) => [component.name, component.status]),
    );
    expect(byName.get("order-desk-health-check")).toBe(HealthStatus.Healthy);
    expect(byName.has("step-slots")).toBe(false);
    expect(report.isBusy).toBe(false); // executionLimits.maxConcurrentSteps: 16, none taken
  });

  test("unhealthy when it does not, with the check's reason", async ({ app, mockService }) => {
    mockService(OrderDeskService).isReachable.mockResolvedValue(false);

    const report = await app.checkReadiness();

    expect(report.status).toBe(HealthStatus.Unhealthy);
    expect(report.components).toContainEqual(
      expect.objectContaining({
        name: "order-desk-health-check",
        reason: "the order system is unreachable",
      }),
    );
  });
});
