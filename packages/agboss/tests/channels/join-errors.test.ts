/**
 * #267 AC10 with #273 S21: a branch fails with a domain error while a sibling is paused — the
 * sibling's pause is withdrawn and the join, in the next pass, routes the branch's error as it was
 * thrown: `.onError(E, …)` by class and cause chain (the domain error, or `StepError`
 * above it), and without a handler the execution fails with the original error object.
 */
import { StepError } from "../../src/core/error-families/step-errors.js";
import { beforeEach, describe, expect } from "vitest";
import { PauseStatus } from "../../src/index.js";
import { callTool, testWith, waitFor, type WorkflowFixtures } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  PaymentDeclinedError,
  PayoutConfirmAgent,
  PayoutDeclinedWorkflowFinish,
  PayoutRefundAgent,
  PayoutStepsApplication,
  PayoutsApplication,
  PayoutUnhandledApplication,
  PayoutWorkflowStart,
} from "./fixtures/payouts.workflow.js";
import {
  ConfirmOrderTool,
  hooks,
  pauseStore,
  RefundTool,
  resetPauses,
  seen,
} from "./fixtures/pauses.workflow.js";
import { until } from "./fixtures/pause-scripts.js";

/** What the finance desk throws for order 7: the one object the execution must fail with. */
const declined = new PaymentDeclinedError("the card of order 7 was declined");

beforeEach(() => {
  resetPauses();
  hooks.refusals = new Map([["7", declined]]);
});

/** The customer is asked first; the refund branch fails five seconds later, while it waits. */
async function payout({
  app,
  clock,
  mockModel,
}: Pick<WorkflowFixtures, "app" | "clock" | "mockModel">) {
  mockModel(PayoutConfirmAgent).thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }));
  mockModel(PayoutRefundAgent).thenReturn(
    waitFor(seconds(5)),
    callTool(RefundTool, { orderId: "7" }),
  );
  const run = execute(app, PayoutWorkflowStart, { orderId: "7" });
  run.catch(() => undefined);
  await until(() => seen.confirmations.length === 1);
  await clock.advance(seconds(5));
  return run;
}

/** The customer's pause, as stored. */
const confirmation = async () => {
  const [ask] = seen.confirmations;
  return ask === undefined
    ? undefined
    : pauseStore().findByTenantIdAndPauseId("default", ask.pauseId);
};

describe("#267 AC10 / #273 S21: .onError(…) after a withdrawal matches by class and cause", () => {
  testWith(PayoutsApplication)(
    "the domain error's own handler takes it; the paused sibling was withdrawn",
    async ({ app, clock, mockModel }) => {
      const done = await payout({ app, clock, mockModel });

      expect(done).toFinishWith(PayoutDeclinedWorkflowFinish, { text: "declined 7" });
      expect((await confirmation())?.status).toBe(PauseStatus.Cancelled);
      expect(seen.refunds).toEqual([]);
      expect(seen.confirmed).toEqual([]);
    },
  );

  testWith(PayoutStepsApplication)(
    "StepError's handler takes it: the agent's failure is a step failure",
    async ({ app, clock, mockModel }) => {
      const done = await payout({ app, clock, mockModel });

      expect(done).toFinishWith(PayoutDeclinedWorkflowFinish, { text: "declined 7" });
      expect((await confirmation())?.status).toBe(PauseStatus.Cancelled);
    },
  );

  testWith(PayoutUnhandledApplication)(
    "no handler: the execution fails with the error object the branch threw, its cause kept",
    async ({ app, clock, mockModel }) => {
      const run = payout({ app, clock, mockModel });

      const failed: unknown = await run.catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(StepError.Agent); // not a copy rebuilt from a record
      expect(failed).toHaveProperty("cause", declined);
      await expect(run).rejects.toFailWith(PaymentDeclinedError);
      expect((await confirmation())?.status).toBe(PauseStatus.Cancelled);
    },
  );
});
