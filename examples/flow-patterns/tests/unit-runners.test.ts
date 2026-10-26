import { describe, expect, it } from "vitest";
import { Injectable } from "@agboss/core";
import { PlainTextDto, WorkflowFinishTextDto } from "@agboss/core/dto";
import {
  callTool,
  override,
  replyWith,
  testAction,
  testArbiter,
  testJudge,
  testPii,
  testRag,
  testRouter,
  testWith,
} from "@agboss/core/testing";
import { ApprovalAgent } from "../src/credit/agents/approval.agent.js";
import { OrderIntakeAgent } from "../src/credit/agents/order-intake.agent.js";
import { ChargeCardAction } from "../src/credit/actions/charge-card.action.js";
import { CreditLimitRouter } from "../src/credit/routers/credit-limit.router.js";
import { DeskAgent } from "../src/desk/agents/desk.agent.js";
import { DeskAnswerJudge } from "../src/desk/judges/desk-answer.judge.js";
import { QuotesLookupJudge } from "../src/desk/judges/quotes-lookup.judge.js";
import { CustomerIdPiiPolicy } from "../src/desk/pii/customer-id.pii-policy.js";
import { ShippingPolicyRag } from "../src/desk/rag/shipping-policy.rag.js";
import { OrderStatusTool } from "../src/desk/tools/order-status.tool.js";
import { DeskWorkflowStart } from "../src/desk/workflow-starts/desk.workflow-start.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { InRangeArbiter } from "../src/panel/arbiters/in-range.arbiter.js";
import { HireScoreAgent } from "../src/panel/agents/hire-score.agent.js";
import { SkillsScoreAgent } from "../src/panel/agents/skills-score.agent.js";
import { BookFlightAction } from "../src/travel/actions/book-flight.action.js";
import { BookingDeskService } from "../src/travel/services/booking-desk.service.js";
import { TripWorkflowStart } from "../src/travel/workflow-starts/trip.workflow-start.js";

/**
 * The unit runners on the patterns' own components (#262 S55): each runs one component on its own
 * container, in its step's frame, input fields as `{ producer, value }` records. The desk's
 * extension points have theirs in desk-units.test.ts.
 */

/** The airline without the network: an `override` replaces the service in the runner's container. */
@Injectable()
class FakeBookingDeskService extends BookingDeskService {
  override bookFlight(destination: string, idempotencyKey: string): Promise<string> {
    return Promise.resolve(`${destination}:${idempotencyKey}`);
  }
}

it("testAction: an undoable action, its service overridden", async () => {
  const runAction = testAction(BookFlightAction, {
    overrides: [override(BookingDeskService, FakeBookingDeskService)],
  });

  const { output } = await runAction({
    request: { producer: TripWorkflowStart, value: { destination: "Lisbon", nights: 3 } },
  });

  expect(output.bookingId).toContain("Lisbon");
});

describe("testRouter: a code router decides at no cost", () => {
  const runRouter = testRouter(CreditLimitRouter);
  const order = (total: number) => ({
    order: { producer: OrderIntakeAgent, value: { customerId: "c-1", total } },
  });

  it("over the limit → approval, under it → the charge", async () => {
    expect((await runRouter(order(500))).output).toBe(ApprovalAgent);
    expect((await runRouter(order(50))).output).toBe(ChargeCardAction);
  });
});

it("testArbiter: the agent and its answer", async () => {
  const runArbiter = testArbiter(InRangeArbiter);

  expect((await runArbiter(SkillsScoreAgent, { score: 8, reason: "senior" })).output).toBe(true);
  expect((await runArbiter(HireScoreAgent, { score: 12, reason: "too keen" })).output).toBe(false);
});

it("testRag: the knowledge base alone, with topK", async () => {
  const { output } = await testRag(ShippingPolicyRag)("is a late order refunded?", { topK: 1 });

  expect(output.map((result) => result.source)).toEqual(["help/refunds.md"]);
});

it("testPii: a project detector masks for the model and reveals back", async () => {
  const pii = testPii([CustomerIdPiiPolicy]);

  const { output: masked } = await pii.mask("CUS-1234 asks about #7");

  expect(masked).not.toContain("CUS-1234");
  expect(pii.reveal(masked)).toBe("CUS-1234 asks about #7");
});

it("testJudge: the eval suite's judge on a finish's output, with the metrics calibrate reads", async () => {
  const runJudge = testJudge(DeskAnswerJudge);
  const answer = (text: string) =>
    runJudge({
      variant: WorkflowFinishTextDto,
      reply: { text },
      task: "Answer",
      attempt: 0,
      toolCalls: [],
    });

  expect((await answer("It says: order 7 shipped")).output).toMatchObject({
    passed: true,
    metrics: { quotesTool: true },
  });
  expect((await answer("Do you have a recent order?")).output).toMatchObject({
    passed: false,
    reason: "the answer does not say where the order is",
  });
});

const test = testWith(FlowPatternsApplication);

test("testJudge: a code judge on the tool calls of a real (scripted) visit", async ({
  app,
  mockLlm,
}) => {
  mockLlm(DeskAgent).thenReturn(
    callTool(OrderStatusTool, { orderId: "7" }),
    replyWith("Order 7 shipped."),
  );
  const { toolCalls } = await app.execute(DeskWorkflowStart, {
    customerId: "c-1",
    question: "Where is #7?",
  });
  const runJudge = testJudge(QuotesLookupJudge);

  const named = await runJudge({
    variant: PlainTextDto,
    reply: { text: "Order 7 shipped." },
    task: "Answer",
    attempt: 0,
    toolCalls,
  });
  const vague = await runJudge({
    variant: PlainTextDto,
    reply: { text: "It shipped." },
    task: "Answer",
    attempt: 0,
    toolCalls,
  });

  expect(named.output).toMatchObject({ passed: true, metrics: { lookups: 1 } });
  expect(vague.output).toMatchObject({
    passed: false,
    reason: "name the order you looked up in the answer",
  });
  expect(named.spend.totalUsd).toBe(0);
});
