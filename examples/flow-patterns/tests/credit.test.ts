import { describe, expect, it } from "vitest";
import { describeWorkflow } from "agboss";
import { replyWith, routeTo, testWith, workflowOf } from "agboss/testing";
import { ChargeCardAction } from "../src/credit/actions/charge-card.action.js";
import { ApprovalAgent } from "../src/credit/agents/approval.agent.js";
import { OrderIntakeAgent } from "../src/credit/agents/order-intake.agent.js";
import { CreditWorkflow } from "../src/credit/credit.workflow.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { CreditApprovalDto } from "../src/credit/dtos/credit-approval.dto.js";
import { CreditOrderDto } from "../src/credit/dtos/credit-order.dto.js";
import { CreditLimitRouter } from "../src/credit/routers/credit-limit.router.js";
import { DeskRouter } from "../src/credit/routers/desk.router.js";
import { CreditServiceUnavailableError } from "../src/credit/services/credit-service-unavailable.error.js";
import { CreditService } from "../src/credit/services/credit.service.js";
import { CreditWorkflowFinish } from "../src/credit/workflow-finishes/credit.workflow-finish.js";
import { NoOrderWorkflowFinish } from "../src/credit/workflow-finishes/no-order.workflow-finish.js";
import { OrderHeldWorkflowFinish } from "../src/credit/workflow-finishes/order-held.workflow-finish.js";
import { CreditWorkflowStart } from "../src/credit/workflow-starts/credit.workflow-start.js";

/** A code router (`route(input)`, no model) inside a model router's route. */

const test = testWith(FlowPatternsApplication);

const order = (total: number) => replyWith(CreditOrderDto, { customerId: "c-1", total });

describe("route() decides by the credit limit ($100 for c-1)", () => {
  test("$50 → charge-card-action, $500 → approval-agent", async ({ app, mockLlm }) => {
    mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent), routeTo(OrderIntakeAgent));
    mockLlm(OrderIntakeAgent).thenReturn(order(50), order(500));
    mockLlm(ApprovalAgent).thenReturn(replyWith(CreditApprovalDto, { approved: true }));

    const small = await app.execute(CreditWorkflowStart, { text: "50 dollars of tea" });
    const large = await app.execute(CreditWorkflowStart, { text: "500 dollars of tea" });

    expect(small).toFollowPath([
      CreditWorkflowStart,
      DeskRouter,
      OrderIntakeAgent,
      CreditLimitRouter,
      ChargeCardAction,
      CreditWorkflowFinish,
    ]);
    expect(large).toFollowPath([
      CreditWorkflowStart,
      DeskRouter,
      OrderIntakeAgent,
      CreditLimitRouter,
      ApprovalAgent,
      ChargeCardAction,
      CreditWorkflowFinish,
    ]);
    expect(large).toFinishWith(CreditWorkflowFinish, { chargeId: "charge-c-1" });
  });

  test("route() calls its service with the step's idempotency key", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(CreditService).limitOf.mockResolvedValue(1_000);
    mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
    mockLlm(OrderIntakeAgent).thenReturn(order(500));

    const result = await app.execute(CreditWorkflowStart, { text: "500 dollars of tea" });

    expect(result.path).not.toContain("approval-agent");
    expect(mockOf(CreditService).limitOf.mock.calls).toEqual([
      [{ customerId: "c-1", requestKey: `${result.runId}:credit-limit-router:1` }],
    ]);
  });

  test("a message that is not an order is handed over", async ({ app, mockLlm }) => {
    mockLlm(DeskRouter).thenReturn(routeTo(NoOrderWorkflowFinish));

    const result = await app.execute(CreditWorkflowStart, { text: "hello" });

    expect(result).toFinishWith(NoOrderWorkflowFinish, { text: "hello" });
  });
});

describe("a failing route()", () => {
  test("credit service down → .onError(CreditServiceUnavailableError) → the held finish", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(CreditService).limitOf.mockRejectedValue(new CreditServiceUnavailableError("down"));
    mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
    mockLlm(OrderIntakeAgent).thenReturn(order(50));

    const result = await app.execute(CreditWorkflowStart, { text: "tea" });

    expect(result).toFollowPath([
      CreditWorkflowStart,
      DeskRouter,
      OrderIntakeAgent,
      CreditLimitRouter,
      OrderHeldWorkflowFinish,
    ]);
    expect(result).toFinishWith(OrderHeldWorkflowFinish, { customerId: "c-1", total: 50 });
  });

  test("another error fails the run: RouterFailedError, the original as its cause", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(CreditService).limitOf.mockRejectedValue(new Error("the credit database is down"));
    mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
    mockLlm(OrderIntakeAgent).thenReturn(order(50));

    const run = app.execute(CreditWorkflowStart, { text: "tea" });

    await expect(run).rejects.toMatchObject({
      name: "RouterFailedError",
      code: "step.router",
      nodeId: "credit-limit-router",
      cause: { message: "the credit database is down" },
    });
  });
});

describe("describe", () => {
  it("a model router by its model, the code router as code", async () => {
    const lines = describeWorkflow(await workflowOf(CreditWorkflow));

    expect(lines).toEqual(
      expect.arrayContaining([
        "  desk-router  decisions typesafe/jev-1.13 (own) · maxVisits 1 — Sends an order to the intake, ends on anything else",
        "  credit-limit-router  code — Sends large orders for approval, charges the rest",
      ]),
    );
  });

  it("the credit service gives big spenders a higher limit", async () => {
    const service = new CreditService();

    await expect(service.limitOf({ customerId: "big-spender", requestKey: "k" })).resolves.toBe(
      10_000,
    );
    await expect(service.limitOf({ customerId: "c-1", requestKey: "k" })).resolves.toBe(100);
  });
});
