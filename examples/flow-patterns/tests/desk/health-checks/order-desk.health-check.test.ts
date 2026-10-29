import { describe, expect } from "vitest";
import { HealthStatus } from "@agboss/core";
import { testWith } from "@agboss/core/testing";
import { OrderDeskService } from "../../../src/desk/services/order-desk.service.js";
import { FlowPatternsApplication } from "../../../src/flow-patterns.application.js";

/** The desk's readiness: its health check and the instance's step cap. */

const test = testWith(FlowPatternsApplication);

describe("readiness: the order system's health check and the instance's step slots", () => {
  test("healthy when the order system answers", async ({ app }) => {
    const report = await app.checkReadiness();

    const byName = new Map(
      report.components.map((component) => [component.name, component.status]),
    );
    expect(byName.get("order-desk-health-check")).toBe(HealthStatus.Healthy);
    expect(byName.get("step-slots")).toBe(HealthStatus.Healthy); // maxConcurrentSteps: 16
  });

  test("unhealthy when it does not, with the check's reason", async ({ app, mockOf }) => {
    mockOf(OrderDeskService).isReachable.mockResolvedValue(false);

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
