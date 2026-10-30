import { describe, expect, it } from "vitest";
import { ExecutionFencedError, IdempotencyKeyConflictError } from "@agboss/core";
import { testAction } from "@agboss/core/testing";
import { ChargeCardAction } from "../../../src/credit/actions/charge-card.action.js";
import { OrderIntakeAgent } from "../../../src/credit/agents/order-intake/order-intake.agent.js";

/**
 * #472, #500, #508: the charge is a fenced effect keyed by its credit application
 * (`credit:<applicationId>`). `testAction` runs every call as the same step of the same execution
 * under the runner's held lease, on one container and one SQLite connection: a second call for one
 * application is the step run again, another application a charge of its own.
 */

const order = (customerId: string, total: number, applicationId = `app-${customerId}`) => ({
  order: { producer: OrderIntakeAgent, value: { applicationId, customerId, total } },
});
const onFile = { environment: { sqlitePath: ":memory:" } };
const runner = () => testAction(ChargeCardAction, onFile);

describe("#500, #508: one charge per credit application", () => {
  it("the step run again gets the charge it made", async () => {
    const runCharge = runner();

    const first = await runCharge(order("c-1", 50));
    const retry = await runCharge(order("c-1", 50));
    const again = await runCharge(order("c-1", 50));

    expect(first.output).toEqual({ chargeId: "charge-c-1-1" });
    expect(retry.output).toEqual(first.output);
    expect(again.output).toEqual(first.output);
  });

  it("#508: another application is a charge of its own, even from the same step", async () => {
    const runCharge = runner();
    await runCharge(order("c-1", 50));

    const other = await runCharge(order("c-2", 70));

    expect(other.output).toEqual({ chargeId: "charge-c-2-2" });
  });

  it("#508 AC3: the same application with another total is IdempotencyKeyConflictError, nothing charged", async () => {
    const runCharge = runner();
    await runCharge(order("c-1", 50, "app-7"));

    await expect(runCharge(order("c-1", 70, "app-7"))).rejects.toBeInstanceOf(
      IdempotencyKeyConflictError,
    );
    const again = await runCharge(order("c-3", 20));
    expect(again.output).toEqual({ chargeId: "charge-c-3-2" });
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
