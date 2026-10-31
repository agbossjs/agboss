import { describe, expect, it } from "vitest";
import { testRouter } from "@agboss/core/testing";
import { ChargeCardAction } from "../../../../src/credit/actions/charge-card.action.js";
import { ApprovalAgent } from "../../../../src/credit/agents/approval/approval.agent.js";
import { OrderIntakeAgent } from "../../../../src/credit/agents/order-intake/order-intake.agent.js";
import { CreditLimitRouter } from "../../../../src/credit/routers/credit-limit/credit-limit.router.js";

/**
 * The unit runner on a code router (#262 S55): it runs on its own container, in its step's frame,
 * input fields as `{ producer, value }` records.
 */

describe("testRouter: a code router decides at no cost", () => {
  const runRouter = testRouter(CreditLimitRouter);
  const order = (total: number) => ({
    order: {
      producer: OrderIntakeAgent,
      value: { applicationId: "app-1", customerId: "c-1", total },
    },
  });

  it("over the limit → approval, under it → the charge", async () => {
    expect((await runRouter(order(500))).output).toBe(ApprovalAgent);
    expect((await runRouter(order(50))).output).toBe(ChargeCardAction);
  });
});
