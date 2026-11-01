/**
 * #656 — the budget's side path across a takeover, on two instances sharing the in-memory stores.
 * The side path that took the budget's limit holds the order on the first instance, whose lease
 * then stalls; the second instance takes the tree over and runs the held visit again. That visit
 * is the side path's own (AC3: it runs past the budget, and so does the team's notice after it);
 * a launch after it ends the side path on the new holder too (AC1: its branches are held back).
 * The old holder's call rejects with `ExecutionLeaseLostError`.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError, nameOf, type Class } from "../../src/index.js";
import {
  testWith,
  type TestApp,
  type TestLeases,
  type VirtualClock,
} from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { readyAll } from "../app/fixtures/child-end-freeze.js";
import { instance, rejectionOf, settle } from "../app/fixtures/fence-takeover.js";
import { PaidExemptionsApplication } from "./fixtures/paid-exemptions.application.js";
import { exemptions, resetExemptions } from "./fixtures/paid-exemptions.actions.js";
import {
  HeldLaunchWorkflowStart,
  HeldLimitWorkflowStart,
  LimitNotedWorkflowFinish,
} from "./fixtures/paid-exemptions.workflow.js";
import { holdOrders, paidSteps, resetPaidSteps } from "./fixtures/paid-steps.dto.js";

const test = testWith(PaidExemptionsApplication, { instances: 2 });

let release: () => void = () => undefined;

beforeEach(() => {
  resetPaidSteps();
  resetExemptions();
  release = holdOrders();
});

afterEach(() => {
  release();
});

const holds = (): number => paidSteps.ran.filter((step) => step === "hold").length;

/** The held side path on the first instance, taken over by the second; then the order let go. */
async function takenOverAtHold(
  apps: readonly TestApp[],
  clock: VirtualClock,
  leases: TestLeases,
  start: Class,
): Promise<unknown> {
  await readyAll(apps);
  const a = instance(apps, 0);
  const call = rejectionOf(execute(a, start, { orderId: "o1" }));
  await until(() => holds() === 1, "the side path's hold on the first instance");
  leases.stall(a);
  for (let step = 0; step < 24 && holds() < 2; step += 1) {
    await clock.advance(seconds(10));
    await settle();
  }
  await until(() => holds() === 2, "the second instance runs the held visit again");
  release();
  await until(() => exemptions.ended.length > 0, "the new holder ended the tree");
  leases.resume(a);
  const error = await call;
  await settle();
  return error;
}

describe("#656: the budget's side path across a takeover", () => {
  test("AC3: the held visit run again by the new holder is the side path's own: it runs, then the notice", async ({
    apps,
    clock,
    leases,
  }) => {
    const error = await takenOverAtHold(apps, clock, leases, HeldLimitWorkflowStart);

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(exemptions.ended).toEqual([nameOf(LimitNotedWorkflowFinish)]);
    expect(paidSteps.ran).toEqual(["charge", "hold", "hold", "notify"]);
  });

  test("AC1: the launch after it ends the side path on the new holder: its branches are held back", async ({
    apps,
    clock,
    leases,
  }) => {
    const error = await takenOverAtHold(apps, clock, leases, HeldLaunchWorkflowStart);

    expect(error).toBeInstanceOf(ExecutionLeaseLostError);
    expect(exemptions.ended).toEqual(["BudgetExceededError"]);
    expect(paidSteps.ran).toEqual(["charge", "hold", "hold"]);
  });
});
