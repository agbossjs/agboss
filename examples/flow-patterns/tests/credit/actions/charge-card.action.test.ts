import { describe, expect, it } from "vitest";
import { ExecutionFencedError } from "@agboss/core";
import { testAction } from "@agboss/core/testing";
import { ChargeCardAction } from "../../../src/credit/actions/charge-card.action.js";
import { OrderIntakeAgent } from "../../../src/credit/agents/order-intake/order-intake.agent.js";

/**
 * #472, #500: the charge is a fenced effect of its step. `testAction` runs every call as the same
 * step of the same execution — one key — under the runner's held lease, on one container and one
 * SQLite connection, so a second call is the step run again.
 */

const order = (customerId: string, total: number) => ({
  order: { producer: OrderIntakeAgent, value: { customerId, total } },
});
const onFile = { environment: { sqlitePath: ":memory:" } };
const runner = () => testAction(ChargeCardAction, onFile);

describe("#500: one charge per step", () => {
  it("the step run again gets the charge it made", async () => {
    const runCharge = runner();

    const first = await runCharge(order("c-1", 50));
    const retry = await runCharge(order("c-1", 50));
    const again = await runCharge(order("c-1", 50));

    expect(first.output).toEqual({ chargeId: "charge-c-1-1" });
    expect(retry.output).toEqual(first.output);
    expect(again.output).toEqual(first.output);
  });

  it("the step's effect is the step's, not its input's: run again with another order, it replays", async () => {
    const runCharge = runner();
    await runCharge(order("c-1", 50));

    const replayed = await runCharge(order("c-2", 70));

    expect(replayed.output).toEqual({ chargeId: "charge-c-1-1" });
  });

  it("each runner is its own file: a fresh one charges from number 1", async () => {
    await runner()(order("c-1", 50));

    const fresh = await runner()(order("c-3", 70));

    expect(fresh.output).toEqual({ chargeId: "charge-c-3-1" });
  });

  it("an instance that lost the lease is refused: ExecutionFencedError, nothing charged", async () => {
    const lost = testAction(ChargeCardAction, { ...onFile, fence: { isLost: true } });

    await expect(lost(order("c-1", 50))).rejects.toBeInstanceOf(ExecutionFencedError);
  });
});
