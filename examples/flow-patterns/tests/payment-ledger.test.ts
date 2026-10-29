import { describe, expect, it } from "vitest";
import { testAction } from "@agboss/core/testing";
import { ChargeCardAction } from "../src/credit/actions/charge-card.action.js";
import { OrderIntakeAgent } from "../src/credit/agents/order-intake/order-intake.agent.js";
import { PaymentKeyReusedError } from "../src/credit/errors/payment-key-reused.error.js";

/**
 * #472: the offline payment provider makes one charge per idempotency key. `testAction` runs every
 * call as the same step of the same execution — one key — on one container and one SQLite
 * connection, so a second call is a retry of that step.
 */

const order = (customerId: string, total: number) => ({
  order: { producer: OrderIntakeAgent, value: { customerId, total } },
});
const runner = () => testAction(ChargeCardAction, { environment: { sqlitePath: ":memory:" } });

describe("#472: one charge per step", () => {
  it("a retry of the same step answers with the charge it made", async () => {
    const runCharge = runner();

    const first = await runCharge(order("c-1", 50));
    const retry = await runCharge(order("c-1", 50));
    const again = await runCharge(order("c-1", 50));

    expect(first.output).toEqual({ chargeId: "charge-c-1-1" });
    expect(retry.output).toEqual(first.output);
    expect(again.output).toEqual(first.output);
  });

  it.each([
    ["another customer", "c-2", 50],
    ["another total", "c-1", 60],
  ])(
    "the key used for %s is refused, not answered with the old charge",
    async (_case, customerId, total) => {
      const runCharge = runner();
      await runCharge(order("c-1", 50));

      const reused = runCharge(order(customerId, total));

      await expect(reused).rejects.toThrow(PaymentKeyReusedError);
    },
  );

  it("each runner is its own ledger: a fresh one charges from number 1", async () => {
    await runner()(order("c-1", 50));

    const fresh = await runner()(order("c-3", 70));

    expect(fresh.output).toEqual({ chargeId: "charge-c-3-1" });
  });
});
