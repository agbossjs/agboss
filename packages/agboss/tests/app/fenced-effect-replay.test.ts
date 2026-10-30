/**
 * #500 AC1, AC3 — the fenced effect in an application: an action charges an order and inserts its
 * row through `saveResultIfAbsent`, with no table of its own. A crash before the checkpoint makes
 * the step run again on the instance that takes the lease over: it charges nothing more and gets
 * the first receipt. Two calls on one key in one step run the write once.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseLostError, FencedEffectStatus } from "../../src/index.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  ends,
  resetRecovery,
  seen as recovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { instance, rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  book,
  ChargeWorkflowStart,
  DoubleChargeWorkflowStart,
  FencedEffectApplication,
  frozenRuns,
  gates,
  letAllGo,
  resetFencedEffect,
} from "./fixtures/fenced-effect.workflow.js";

const test = testWith(FencedEffectApplication);
const two = testWith(FencedEffectApplication, { instances: 2 });
const real = testWith(FencedEffectApplication, { concurrency: TestConcurrency.Real });

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
});

afterEach(() => {
  letAllGo();
});

describe("#500 AC1: one call charges once", () => {
  test("AC1: the action's write runs and its receipt is the stored one (Ran, token 1)", async ({
    app,
  }) => {
    const result = await execute(app, ChargeWorkflowStart, { text: "order-7" });

    expect(result.output).toEqual({ chargeId: "charge-order-7-1" });
    expect(book.charges).toEqual([{ order: "order-7", token: 1, chargeId: "charge-order-7-1" }]);
    expect(book.runs).toEqual([{ token: 1, status: FencedEffectStatus.Ran }]);
  });

  two(
    "AC1: a crash before the checkpoint charges once and the replay gets the first receipt",
    async ({ apps, clock, leases }) => {
      gates.after = 1;
      const [a, b] = [instance(apps, 0), instance(apps, 1)];
      await a.ready();
      await b.ready();
      const call = execute(a, ChargeWorkflowStart, { text: "order-7" });
      call.catch(() => undefined);
      await frozenRuns(1);
      // A charged and froze before its checkpoint; B's sweep takes the lease over (token 2)
      leases.stall(a);
      await clock.advance(seconds(31));
      await clock.advance(seconds(31));
      const [end] = await ends(1);

      expect(book.charges).toEqual([{ order: "order-7", token: 1, chargeId: "charge-order-7-1" }]);
      expect(book.runs).toEqual([
        { token: 1, status: FencedEffectStatus.Ran },
        { token: 2, status: FencedEffectStatus.Replayed },
      ]);
      expect(end?.output).toEqual({ chargeId: "charge-order-7-1" });

      // A wakes: its checkpoint write finds the lease lost — a hand-over, nothing charged again
      letAllGo();
      leases.resume(a);
      await settle();
      expect(await rejectionOf(call)).toBeInstanceOf(ExecutionLeaseLostError);
      expect(book.charges).toHaveLength(1);
      expect(recovery.errors).toEqual([]);
    },
  );
});

describe("#500 AC3: two calls on one key in one step", () => {
  real(
    "AC3: run the write once — the second joins the first, both get its receipt",
    async ({ app }) => {
      const result = await execute(app, DoubleChargeWorkflowStart, { text: "order-8" });

      expect(result.output).toEqual({ chargeId: "order-8" });
      expect(book.charges).toHaveLength(1);
      expect(book.runs.map((run) => run.status)).toEqual([
        FencedEffectStatus.Ran,
        FencedEffectStatus.Joined,
      ]);
    },
  );
});

describe("#500: where no lease is held", () => {
  test("a budget's maxSpend() gets ExecutionContextUnavailableError from fencedEffectKeyOf", async ({
    app,
  }) => {
    await execute(app, ChargeWorkflowStart, { text: "order-9" });

    expect(book.budgetKey).toHaveLength(1);
    expect(String(book.budgetKey[0])).toMatch(/where no lease is held/);
    expect(book.budgetKey[0]).toMatchObject({ code: "context.unavailable" });
  });
});
