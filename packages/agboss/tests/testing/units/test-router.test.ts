/**
 * #262 PR 3 (S89): `testUnit` — a code router's `route(input)` on its own container, its answer
 * checked against its routes; a model router's texts loaded and its model answering by script.
 */
import { StepError } from "../../../src/core/error-families/step-errors.js";
import { describe, expect, it } from "vitest";
import {
  decideWith,
  failWith,
  ModelFailure,
  routeTo,
  testUnit,
} from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import {
  ApprovalAgent,
  ChargeCardAction,
  CreditLimitRouter,
  CreditService,
  CreditWorkflowStart,
  DeskRouter,
  NoOrderWorkflowFinish,
  OrderIntakeAgent,
} from "../../flow/fixtures/credit.fixture.js";
import { CreditOrderDto } from "../../flow/fixtures/credit-dtos.js";
import { WorkflowStartTextDto } from "../../flow/fixtures/dtos.js";
import {
  HelpDeskRouter,
  HelpDeskWorkflowStart,
  OffersRouter,
  OffersWorkflowStart,
  RefundPolicyAgent,
  LoyaltyOfferAgent,
} from "../../flow/fixtures/launch.fixture.js";
import {
  ManualQuoteWorkflowFinish,
  PriceListService,
  PriceQuoteAction,
  QuoteSizeRouter,
  QuoteWorkflowStart,
} from "../../flow/fixtures/units.fixture.js";
import { Injectable } from "../../../src/components/decorators.js";
import { FakePriceListService, OffRouteRouter, produced } from "./fakes.js";
import {
  CritiqueAction,
  CritiqueRouter,
  PolishedWorkflowFinish,
} from "../../flow/fixtures/review.fixture.js";

@Injectable()
class GenerousCreditService extends CreditService {
  override limitOf(): Promise<number> {
    return Promise.resolve(1_000_000);
  }
}

const order = (customerId: string, total: number) => ({
  order: produced(OrderIntakeAgent, Object.assign(new CreditOrderDto(), { customerId, total })),
});

describe("testUnit: a code router", () => {
  it("route(input) chooses on its replaced service, at no cost", async () => {
    const runRouter = testUnit(QuoteSizeRouter, {
      services: [FakePriceListService],
    });

    const small = await runRouter({
      request: produced(QuoteWorkflowStart, { product: "pen", quantity: 2 }),
    });
    const large = await runRouter({
      request: produced(QuoteWorkflowStart, { product: "pen", quantity: 100 }),
    });

    expect(small.output).toBe(PriceQuoteAction);
    expect(large.output).toBe(ManualQuoteWorkflowFinish);
    expect(small.spend.totalUsd).toBe(0);
  });

  it("its step's frame: the injected context reads the router's step", async () => {
    const runRouter = testUnit(CreditLimitRouter, {
      services: [GenerousCreditService],
    });

    const { output } = await runRouter({
      order: produced(OrderIntakeAgent, { customerId: "c", total: 5 }),
    });

    expect(output).toBe(ChargeCardAction);
  });

  it("what route() throws rejects as it was thrown", async () => {
    const runRouter = testUnit(QuoteSizeRouter);

    await expect(
      runRouter({ request: produced(QuoteWorkflowStart, { product: "pen", quantity: 1 }) }),
    ).rejects.toThrow("the real price list was asked for pen");
  });

  it("before a launch: the OnDemand targets it returned, or none with an Always route", async () => {
    const runRouter = testUnit(OffersRouter);
    const message = (text: string) => ({ message: produced(OffersWorkflowStart, { text }) });

    const loyal = await runRouter(message("a loyal customer"));
    const other = await runRouter(message("a refund"));

    expect(loyal.output).toEqual([LoyaltyOfferAgent]);
    expect(other.output).toEqual([]);
  });
});

describe("testUnit: a model router", () => {
  const message = (text: string) => ({ message: produced(CreditWorkflowStart, { text }) });

  it("its model chooses one route by script; the cost is its spend", async () => {
    const runRouter = testUnit(DeskRouter, {
      model: routeTo(OrderIntakeAgent, { cost: usd(0.004) }),
    });

    const { output, spend } = await runRouter(message("two pens please"));

    expect(output).toBe(OrderIntakeAgent);
    expect(spend.byCaller).toEqual({ "router:desk-router": 0.004 });
  });

  it("the turns answer its calls in order", async () => {
    const runRouter = testUnit(DeskRouter, {
      model: [routeTo(OrderIntakeAgent), routeTo(NoOrderWorkflowFinish)],
    });

    const first = await runRouter(message("an order"));
    const second = await runRouter(message("hello"));

    expect([first.output, second.output]).toEqual([OrderIntakeAgent, NoOrderWorkflowFinish]);
  });

  it("a failed model call rejects with StepError.Router, its cause kept", async () => {
    const runRouter = testUnit(DeskRouter, { model: failWith(ModelFailure.Timeout) });

    await expect(runRouter(message("x"))).rejects.toBeInstanceOf(StepError.Router);
  });

  it("a script outside its routes fails the call, naming the routes", async () => {
    // @ts-expect-error — ApprovalAgent is not one of desk-router's routes
    const runRouter = testUnit(DeskRouter, { model: routeTo(ApprovalAgent) });

    await expect(runRouter(message("x"))).rejects.toThrow("not one of its routes");
  });

  it("before a launch: its OnDemand routes decided, the Always ones not its to choose", async () => {
    const runRouter = testUnit(HelpDeskRouter, {
      model: decideWith({ "refund-policy-agent": 0.9 }),
    });

    const { output } = await runRouter({
      message: produced(HelpDeskWorkflowStart, { text: "return it" }),
    });

    expect(output).toEqual([RefundPolicyAgent]);
  });

  it("a list input is shown as its producers' values; the scripted route is taken", async () => {
    const runRouter = testUnit(CritiqueRouter, { model: routeTo(PolishedWorkflowFinish) });

    const { output } = await runRouter({
      critiques: [
        produced(CritiqueAction, { remark: "fine" }),
        produced(CritiqueAction, { remark: "ok" }),
      ],
    });

    expect(output).toBe(PolishedWorkflowFinish);
  });

  it("a router without a script has no live model to call", async () => {
    const runRouter = testUnit(DeskRouter);

    await expect(runRouter(message("x"))).rejects.toThrow("has no script");
  });

  it("a class that is no @Router is a setup error", () => {
    expect(() => testUnit(WorkflowStartTextDto)).toThrow("not a component it runs");
  });

  it("a code router's answer outside its routes is StepError.RouterDecision", async () => {
    // its answer is outside its routes, so the generated types have no runner for it: called untyped
    const runRouter: (input: unknown) => Promise<unknown> = testUnit(OffRouteRouter) as never;

    await expect(
      runRouter({ request: produced(QuoteWorkflowStart, { product: "x", quantity: 1 }) }),
    ).rejects.toBeInstanceOf(StepError.RouterDecision);
  });
});
