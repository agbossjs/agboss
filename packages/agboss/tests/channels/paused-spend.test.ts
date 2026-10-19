/**
 * #267: the spend of an execution paused in several agent loops is the sum over every paused loop
 * of its tree — in `result.spend` and in the budget ledger — and a resume counts nothing twice.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  callTool,
  replyWith,
  testWith,
  type ModelRequest,
  type ScriptedTurn,
} from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { RefundDoneDto, RefundTool, resetPauses } from "./fixtures/pauses.workflow.js";
import {
  LOOKUP_COST,
  PricedRefundAgent,
  PriceOrderTool,
  PricedPausesApplication,
  costLedger,
  type SeenCostLedgerRepository,
} from "./fixtures/priced-pauses.workflow.js";
import { BatchWorkflowStart } from "./fixtures/pauses.workflow.js";
import { answerFor, manager, orderOf } from "./fixtures/pause-scripts.js";

const test = testWith(PricedPausesApplication);
const ORDERS = [{ orderId: "A" }, { orderId: "B" }];

beforeEach(resetPauses);

/** How many tool results the request already carries: the agent's turn in its loop. */
const turnOf = (request: ModelRequest): number =>
  request.kind === "chat" ? request.messages.filter((line) => line.role === "tool").length : 0;

/** Each order is priced (paid), then its refund pauses; answered, the agent replies. */
const pricedRefunder = (request: ModelRequest): ScriptedTurn => {
  const orderId = orderOf(request);
  const turns = [
    callTool(PriceOrderTool, { orderId }),
    callTool(RefundTool, { orderId }),
    replyWith(RefundDoneDto, { orderId }),
  ];
  return (
    turns[Math.min(turnOf(request), turns.length - 1)] ?? replyWith(RefundDoneDto, { orderId })
  );
};

/** What the ledger counted for the paid lookups. */
const lookupsIn = (ledger: SeenCostLedgerRepository): number =>
  ledger.recorded
    .filter((record) => record.caller === "tool:price_order")
    .reduce((total, record) => total + record.costUsd, 0);

describe("#267: spend with several paused agent loops", () => {
  test("two paused branches, each spent: the execution's spend and the ledger hold both", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(PricedRefundAgent).thenAnswer(pricedRefunder);

    const paused = await execute(app, BatchWorkflowStart, ORDERS);

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(paused.pending).toHaveLength(2);
    expect(paused.spend.totalUsd).toBeCloseTo(2 * LOOKUP_COST);
    expect(paused.spend.byCaller["tool:price_order"]).toBeCloseTo(2 * LOOKUP_COST);
    const ledger = costLedger();
    expect(lookupsIn(ledger)).toBeCloseTo(2 * LOOKUP_COST);
    const modelCallsAtPause = ledger.recorded.filter(
      (record) => record.caller === "priced-refund-agent",
    ).length;
    expect(modelCallsAtPause).toBe(4); // two turns in each loop: price, then refund

    const again = await app.resume(answerFor("A"), manager);

    // A finished, B still waits: B's loop is counted once, A's spend is the flow's now
    expect(again.status).toBe(ExecutionStatus.Paused);
    expect(again.spend.byCaller["tool:price_order"]).toBeCloseTo(2 * LOOKUP_COST);
    expect(lookupsIn(ledger)).toBeCloseTo(2 * LOOKUP_COST);

    const done = await app.resume(answerFor("B"), manager);

    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(done.spend.byCaller["tool:price_order"]).toBeCloseTo(2 * LOOKUP_COST);
    expect(lookupsIn(ledger)).toBeCloseTo(2 * LOOKUP_COST); // a resume counts nothing twice
    expect(
      ledger.recorded.filter((record) => record.caller === "priced-refund-agent"),
    ).toHaveLength(6);
  });
});
