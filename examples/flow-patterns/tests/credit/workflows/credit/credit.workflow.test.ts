import { afterEach, beforeEach, describe, expect } from "vitest";
import {
  AgentAnswerInvalidError,
  BudgetExceededError,
  ExecutionLeaseLostError,
  ExecutionLeaseRepository,
} from "@agboss/core";
import { seconds, usd } from "@agboss/core/units";
import { TenantDailyBudget } from "../../../../src/config/budget.config.js";
import {
  override,
  replyWith,
  replyWithInvalidAnswer,
  routeTo,
  testWith,
} from "@agboss/core/testing";
import { DeskMetricsObserver } from "../../../../src/desk/observers/desk-metrics.observer.js";
import {
  CrashAfterChargeAction,
  crash,
  EndsSeenObserver,
  endOf,
  MortalExecutionLeaseRepository,
  resetCrash,
} from "./support/credit-crash.js";
import { ChargeCardAction } from "../../../../src/credit/actions/charge-card.action.js";
import { ApprovalAgent } from "../../../../src/credit/agents/approval/approval.agent.js";
import { OrderIntakeAgent } from "../../../../src/credit/agents/order-intake/order-intake.agent.js";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";
import { CreditApprovalDto } from "../../../../src/credit/dto/credit-approval.dto.js";
import { CreditOrderDto } from "../../../../src/credit/dto/credit-order.dto.js";
import { CreditLimitRouter } from "../../../../src/credit/routers/credit-limit/credit-limit.router.js";
import { DeskRouter } from "../../../../src/credit/routers/desk/desk.router.js";
import { CreditServiceUnavailableError } from "../../../../src/credit/errors/credit-service-unavailable.error.js";
import { CreditService } from "../../../../src/credit/services/credit.service.js";
import { CreditWorkflowFinish } from "../../../../src/credit/workflows/credit/credit.workflow-finish.js";
import { NoOrderWorkflowFinish } from "../../../../src/credit/workflows/credit/no-order.workflow-finish.js";
import { OrderHeldWorkflowFinish } from "../../../../src/credit/workflows/credit/order-held.workflow-finish.js";
import { CreditWorkflowStart } from "../../../../src/credit/workflows/credit/credit.workflow-start.js";

/** A code router (`route(input)`, no model) inside a model router's route. */

const test = testWith(FlowPatternsApplication);

/** The order of credit application `app-<total>`: each total its own application. */
const order = (total: number) =>
  replyWith(CreditOrderDto, { applicationId: `app-${String(total)}`, customerId: "c-1", total });

describe("#508 AC2: one credit application, two executions on two threads", () => {
  test("AC2: the second execution gets the first charge; the next application is charge 2", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DeskRouter).thenReturn(
      routeTo(OrderIntakeAgent),
      routeTo(OrderIntakeAgent),
      routeTo(OrderIntakeAgent),
    );
    mockLlm(OrderIntakeAgent).thenReturn(order(50), order(50), order(60));

    const first = await app.execute(CreditWorkflowStart, {
      text: "application app-50: $50 of tea",
    });
    const second = await app.execute(CreditWorkflowStart, { text: "application app-50 again" });
    const next = await app.execute(CreditWorkflowStart, { text: "application app-60: $60 of tea" });

    expect(second.threadId).not.toBe(first.threadId);
    expect(first).toFinishWith(CreditWorkflowFinish, { chargeId: "charge-c-1-1" });
    expect(second).toFinishWith(CreditWorkflowFinish, { chargeId: "charge-c-1-1" });
    expect(next).toFinishWith(CreditWorkflowFinish, { chargeId: "charge-c-1-2" });
  });
});

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
    // two orders are two charges: each credit application has its own business key (#508)
    expect(small).toFinishWith(CreditWorkflowFinish, { chargeId: "charge-c-1-1" });
    expect(large).toFinishWith(CreditWorkflowFinish, { chargeId: "charge-c-1-2" });
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
      [{ customerId: "c-1", requestKey: `${result.executionId}:credit-limit-router:1` }],
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
    expect(result).toFinishWith(OrderHeldWorkflowFinish, {
      applicationId: "app-50",
      customerId: "c-1",
      total: 50,
    });
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

describe("budgets (#261): the credit desk's own execution budget, the tenant's day", () => {
  test("the desk's $0.05 is spent: the next step never runs", async ({ app, mockLlm }) => {
    mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
    mockLlm(OrderIntakeAgent).thenReturn(
      replyWith(
        CreditOrderDto,
        { applicationId: "app-1", customerId: "c-1", total: 500 },
        { cost: usd(0.06) },
      ),
    );

    const run = app.execute(CreditWorkflowStart, { text: "500 dollars of tea" });

    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(run).rejects.toMatchObject({ budget: { name: "credit-execution-budget" } });
    expect(mockLlm(ApprovalAgent).requests).toHaveLength(0);
  });

  test("a tenant whose day is spent is refused before any call", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(TenantDailyBudget).maxSpend.mockReturnValue(usd(0));

    const run = app.execute(CreditWorkflowStart, { text: "tea" }, { tenant: { tenantId: "acme" } });

    await expect(run).rejects.toThrow("tenant acme spent $0 today; tenant-daily-budget allows $0");
    expect(mockLlm(DeskRouter).requests).toHaveLength(0);
  });
});

test("an answer that does not fit the agent's DTO is sent back; the third fails the step", async ({
  app,
  mockLlm,
}) => {
  mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
  mockLlm(OrderIntakeAgent).thenReturn(
    ...[1, 2, 3].map(() =>
      replyWithInvalidAnswer(CreditOrderDto, {
        applicationId: "app-1",
        customerId: "c-1",
        total: "lots",
      }),
    ),
  );

  await expect(app.execute(CreditWorkflowStart, { text: "lots of tea" })).rejects.toFailWith(
    AgentAnswerInvalidError,
  );
});

/**
 * #472 AC2, #500 AC1: the charge is made, then its instance dies before the step's checkpoint is
 * written — another instance on the same file recovers the execution and runs the step again under
 * the next lease token; its fenced effect replays the first receipt, so there is one charge.
 */
const instances = testWith(FlowPatternsApplication, {
  instances: 2,
  env: "instances",
  overrides: [
    override(ExecutionLeaseRepository, MortalExecutionLeaseRepository),
    override(ChargeCardAction, CrashAfterChargeAction),
    override(DeskMetricsObserver, EndsSeenObserver),
  ],
});

describe("#472, #500 AC1: a crash after the charge, before its checkpoint", () => {
  beforeEach(resetCrash);
  afterEach(resetCrash);

  instances(
    "the recovered step charges no second time: one charge, the same chargeId",
    async ({ apps, clock, mockLlm }) => {
      mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
      mockLlm(OrderIntakeAgent).thenReturn(
        replyWith(CreditOrderDto, { applicationId: "app-1", customerId: "c-crash", total: 50 }),
      );
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances expected");
      await Promise.all([first.ready(), second.ready()]);
      const charged = new Promise<void>((resolve) => {
        crash.charged = resolve;
      });

      const dying = first.execute(CreditWorkflowStart, { text: "50 dollars of tea" });
      dying.catch(() => undefined);
      await charged;
      crash.dead.add("instance-1");
      await clock.advance(seconds(31));
      const ended = await endOf("credit-workflow");

      await expect(dying).rejects.toBeInstanceOf(ExecutionLeaseLostError);
      const key = `${ended.executionId}:charge-card-action:1`;
      const charge = { chargeNumber: 1, customerId: "c-crash", total: 50 };
      expect(crash.charges).toEqual([
        {
          instanceId: "instance-1",
          idempotencyKey: key,
          chargeId: "charge-c-crash-1",
          ledger: [charge],
        },
        {
          instanceId: "instance-2",
          idempotencyKey: key,
          chargeId: "charge-c-crash-1",
          ledger: [charge],
        },
      ]);
      expect(ended.finish.name).toBe("credit-workflow-finish");
      expect(crash.ends.map((event) => event.executionId)).toEqual([ended.executionId]);
    },
  );
});
