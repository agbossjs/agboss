import { beforeEach, describe, expect, it } from "vitest";
import { describeWorkflow } from "../../../src/describe/describe-workflow.js";
import { nameOf, RouterFailedError } from "../../../src/index.js";
import { replyWith, routeTo, testWith, workflowOf } from "../../../src/testing/index.js";
import { ChargeResultDto, CreditApprovalDto, CreditOrderDto } from "../fixtures/credit-dtos.js";
import {
  ApprovalAgent,
  ChargeCardAction,
  CreditLimitByModelRouter,
  CreditLimitRouter,
  CreditService,
  CreditServiceUnavailableError,
  CreditWorkflow,
  CreditWorkflowFinish,
  CreditWorkflowStart,
  creditDecisions,
  DeskRouter,
  OrderHeldWorkflowFinish,
  OrderIntakeAgent,
  CreditByModelApplication,
  CreditApplication,
} from "../fixtures/credit.fixture.js";

/** #280 AC1, AC5: a router decided by code — `route(input)`, no model call, the same flow. */

const test = testWith(CreditApplication);
const byModel = testWith(CreditByModelApplication);

const order = (total: number) => replyWith(CreditOrderDto, { customerId: "c-1", total });

beforeEach(() => {
  creditDecisions.length = 0;
});

describe("AC1: route() decides", () => {
  test("a small order is charged, a large one goes for approval", async ({ app, mockLlm }) => {
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

  test("model and code routers in one flow: only the model router calls a model", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
    mockLlm(OrderIntakeAgent).thenReturn(order(50));

    const result = await app.execute(CreditWorkflowStart, { text: "tea" });

    expect(result.spend.trace.map((line) => line.caller)).not.toContain(
      "router:credit-limit-router",
    );
    expect(() => mockLlm(CreditLimitRouter)).toThrow(
      "mockLlm(CreditLimitRouter): a code router calls no model — mockOf() the services its route() uses",
    );
  });

  test("route() reads its execution through deps: [ExecutionContext]", async ({ app, mockLlm }) => {
    mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
    mockLlm(OrderIntakeAgent).thenReturn(order(50));

    const result = await app.execute(CreditWorkflowStart, { text: "tea" });

    expect(creditDecisions).toEqual([
      {
        nodeId: "credit-limit-router",
        visitNumber: 1,
        key: `${result.executionId}:credit-limit-router:1`,
      },
    ]);
  });

  test("the service route() calls is the router's dependency: a mock replaces it", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(CreditService).limitOf.mockResolvedValue(1_000);
    mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
    mockLlm(OrderIntakeAgent).thenReturn(order(500));

    const result = await app.execute(CreditWorkflowStart, { text: "tea" });

    expect(result.path).not.toContain("approval-agent");
    expect(mockOf(CreditService).limitOf.mock.calls).toEqual([["c-1"]]);
  });
});

describe("AC1 (S19): a failing route() is RouterFailedError, its cause caught by .onError", () => {
  test("the service's domain error takes the router's .onError through the cause", async ({
    app,
    mockLlm,
    mockOf,
  }) => {
    mockOf(CreditService).limitOf.mockRejectedValue(new CreditServiceUnavailableError("down"));
    mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
    mockLlm(OrderIntakeAgent).thenReturn(order(50));

    const result = await app.execute(CreditWorkflowStart, { text: "tea" }, { record: true });

    expect(result).toFollowPath([
      CreditWorkflowStart,
      DeskRouter,
      OrderIntakeAgent,
      CreditLimitRouter,
      OrderHeldWorkflowFinish,
    ]);
    expect(result).toFinishWith(OrderHeldWorkflowFinish, { customerId: "c-1", total: 50 });
  });

  test("another error fails the execution naming the router, the original as its cause", async ({
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
      visitNumber: 1,
      component: { name: "credit-limit-router" },
      cause: { message: "the credit database is down" },
    });
    await expect(run).rejects.toFailWith(RouterFailedError, { nodeId: nameOf(CreditLimitRouter) });
  });
});

describe("AC5: the same flow for both kinds", () => {
  byModel(
    "a model router in the code router's place takes the same paths",
    async ({ app, mockLlm }) => {
      mockLlm(DeskRouter).thenReturn(routeTo(OrderIntakeAgent));
      mockLlm(OrderIntakeAgent).thenReturn(order(50));
      mockLlm(CreditLimitByModelRouter).thenReturn(routeTo(ChargeCardAction));

      const result = await app.execute(CreditWorkflowStart, { text: "tea" });

      expect(result).toFollowPath([
        CreditWorkflowStart,
        DeskRouter,
        OrderIntakeAgent,
        CreditLimitByModelRouter,
        ChargeCardAction,
        CreditWorkflowFinish,
      ]);
      expect(result.output).toEqual(
        Object.assign(new ChargeResultDto(), { chargeId: "charge-c-1" }),
      );
    },
  );
});

describe("M1: describe shows how each router decides", () => {
  it("a model router by its model, a code router as code", async () => {
    const lines = describeWorkflow(await workflowOf(CreditWorkflow));

    expect(lines).toEqual(
      expect.arrayContaining([
        "routers",
        "  desk-router  decisions typesafe/jev-1.13 (own) — Sends an order to the intake, ends on anything else",
        "  credit-limit-router  code — Sends large orders for approval, charges the rest",
      ]),
    );
  });
});
