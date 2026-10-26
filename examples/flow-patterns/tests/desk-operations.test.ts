import { describe, expect } from "vitest";
import { HealthStatus, QualityGateError } from "@agboss/core";
import { callTool, replyWith, testWith } from "@agboss/core/testing";
import { DeskAgent } from "../src/desk/agents/desk.agent.js";
import { OrderDeskService } from "../src/desk/services/order-desk.service.js";
import { DeskMetricsService } from "../src/desk/services/desk-metrics.service.js";
import { OrderStatusTool } from "../src/desk/tools/order-status.tool.js";
import { DeskAnswerWorkflowFinish } from "../src/desk/workflow-finishes/desk-answer.workflow-finish.js";
import { DeskWorkflowStart } from "../src/desk/workflow-starts/desk.workflow-start.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";

/** The desk's operational contracts: its judge, PII policy, observer, health check and step cap. */

const test = testWith(FlowPatternsApplication);

describe("the code judge reads the visit's tool calls", () => {
  test("an answer that does not name the order looked up is sent back once", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DeskAgent).thenReturn(
      callTool(OrderStatusTool, { orderId: "7" }),
      replyWith("It shipped on Monday."), // rejected: no order named
      replyWith("Order 7 shipped on Monday."),
    );

    const result = await app.execute(
      DeskWorkflowStart,
      { customerId: "c-1", question: "Where is #7?" },
      { record: true },
    );

    const steps = result.record?.steps.filter((entry) => entry.step.nodeId === "desk-agent") ?? [];
    expect(steps.flatMap((entry) => entry.judgeVerdicts.map((verdict) => verdict.passed))).toEqual([
      false,
      true,
    ]);
    expect(result).toFinishWith(DeskAnswerWorkflowFinish, { text: "Order 7 shipped on Monday." });
  });

  test("retries spent: QualityGateError with the judge's reason", async ({ app, mockLlm }) => {
    mockLlm(DeskAgent).thenReturn(
      callTool(OrderStatusTool, { orderId: "7" }),
      replyWith("It shipped."),
      replyWith("It shipped, really."),
    );

    await expect(
      app.execute(DeskWorkflowStart, { customerId: "c-1", question: "Where is #7?" }),
    ).rejects.toFailWith(QualityGateError, {
      rejections: [
        { judge: "quotes-lookup-judge", reason: "name the order you looked up in the answer" },
      ],
    });
  });
});

test("a customer id is masked in what the model reads", async ({ app, mockLlm }) => {
  mockLlm(DeskAgent).thenReturn(replyWith("We will look into it."));

  await app.execute(DeskWorkflowStart, {
    customerId: "CUS-1234",
    question: "CUS-1234 here: is #7 late?",
  });

  const { input } = mockLlm(DeskAgent).lastRequest; // what the model read
  expect(input).not.toContain("CUS-1234");
  expect(input).toContain("<customer-id:");
});

test("the observer counts the desk's answers and tool calls", async ({ app, mockLlm, mockOf }) => {
  const metrics = mockOf(DeskMetricsService); // before the app starts
  mockLlm(DeskAgent).thenReturn(
    callTool(OrderStatusTool, { orderId: "7" }),
    replyWith("Order 7 shipped."),
  );

  await app.execute(DeskWorkflowStart, { customerId: "c-1", question: "Where is #7?" });

  expect(metrics.increment.mock.calls).toEqual([
    ["desk_tool_call", { tool: "order-status-tool" }],
    ["desk_answered", { finish: "desk-answer-workflow-finish" }],
  ]);
});

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
