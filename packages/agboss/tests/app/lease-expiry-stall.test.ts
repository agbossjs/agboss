/**
 * #534 AC3 — a holder stalled like a stop-the-world GC pause, its lease store calls and timers held
 * while its step waits, then let go at the lease's boundary. 1 ms before its fence (#533: the lease
 * less its safety margin, 29 s) it renews and charges once under its own token. At its expiry and
 * after it the lease is over for it too: it hands the tree over (its call rejects with `ExecutionLeaseLostError`), the recovery sweep takes it
 * over from that very holder, and the order is charged exactly once, under the next token — one
 * owner at a time, no work lost, no second charge.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ExecutionLeaseEventKind, ExecutionLeaseLostError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  ends,
  resetRecovery,
  seen as recovery,
} from "../infrastructure/fixtures/recovery.workflow.js";
import { rejectionOf, settle } from "./fixtures/fence-takeover.js";
import {
  book,
  ChargeWorkflowStart,
  frozenRuns,
  gates,
  letAllGo,
  resetFencedEffect,
} from "./fixtures/fenced-effect.workflow.js";
import {
  FencedEffectEventsApplication,
  resetLeaseEvents,
} from "./fixtures/lease-events.application.js";

const test = testWith(FencedEffectEventsApplication);

beforeEach(() => {
  resetFencedEffect();
  resetRecovery();
  resetLeaseEvents();
});

afterEach(() => {
  letAllGo();
});

/** The tree of the charge: the test's first execution. */
const ROOT = "execution-1";

/** How long each stall lasts, from the lease's take: past the expiry, exactly at it, and later. */
const HANDED_OVER: readonly (readonly [string, Milliseconds])[] = [
  ["exactly at its expiry", seconds(30)],
  ["1 ms after its expiry", seconds(30.001)],
  ["a whole lease past its expiry", seconds(60)],
];

describe("#534 AC3: a holder stalled past its lease's expiry hands over cleanly", () => {
  test("AC3, #533: stalled until 1 ms before its fence (the lease less its safety margin), the holder renews and charges once, no takeover", async ({
    app,
    clock,
    leases,
  }) => {
    gates.before = 1;
    await app.ready();
    const call = execute(app, ChargeWorkflowStart, { text: "order-7" });
    await frozenRuns(1);
    leases.stall(app);
    await clock.advance(seconds(28.999));

    leases.resume(app);
    await settle();
    letAllGo();
    await call;
    const rows = await app.leaseEventsOf({ tenantId: "default", rootExecutionId: ROOT });

    expect(book.charges.map((charge) => charge.token)).toEqual([1]);
    expect(rows.filter((row) => row.kind === ExecutionLeaseEventKind.Takeover)).toEqual([]);
  });

  test.for(HANDED_OVER)(
    "AC3: stalled until %s, the holder hands over, the sweep takes the tree over from it and charges once",
    async ([, stall], { app, clock, leases }) => {
      gates.before = 1;
      await app.ready();
      const call = execute(app, ChargeWorkflowStart, { text: "order-7" });
      call.catch(() => undefined);
      await frozenRuns(1);
      leases.stall(app);
      await clock.advance(stall);

      leases.resume(app);
      await settle();
      letAllGo();
      const error = await rejectionOf(call);
      await clock.advance(seconds(31));
      await ends(1);
      const rows = await app.leaseEventsOf({ tenantId: "default", rootExecutionId: ROOT });

      expect(error).toBeInstanceOf(ExecutionLeaseLostError);
      expect(book.charges.map((charge) => charge.token)).toEqual([2]);
      expect(book.runs.filter((run) => run.status !== "refused")).toHaveLength(1);
      expect(rows.filter((row) => row.kind === ExecutionLeaseEventKind.Takeover)).toEqual([
        expect.objectContaining({
          holderInstanceId: "instance-1",
          token: 2,
          previousHolderInstanceId: "instance-1",
          previousToken: 1,
        }),
      ]);
      expect(recovery.ends).toHaveLength(1);
      expect(recovery.errors).toEqual([]);
    },
  );
});
