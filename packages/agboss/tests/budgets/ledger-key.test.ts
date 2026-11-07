/**
 * #810 (money) — a spend of its own identity (`UsageRecord.ledgerKey`): the same charge made by two
 * passes of one execution — a takeover that runs the step again and replays an A2A call's accept —
 * is one entry of the ledger, whichever pass writes it first and in either order; a spend without
 * one is the pass's own and counts on each pass, as before.
 */
import { describe, expect, it } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import {
  BudgetMeter,
  counterOf,
  type ExecutionBudgetRecord,
} from "../../src/budgets/execution-budgets.js";
import { recordToolCost, type UsageRecord } from "../../src/finops/usage.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { BudgetExceededError } from "../../src/graph/limits.js";
import { VirtualClock } from "../../src/testing/index.js";

const NOW = new Date("2026-11-04T12:00:00.000Z");

const budget: ExecutionBudgetRecord = {
  budget: { name: "execution-budget" },
  scope: BudgetScope.Execution,
  key: "execution-1",
  maxSpend: 100,
};

const keyed = (costUsd: number, id: string): UsageRecord => ({
  ...recordToolCost("pay-tool", costUsd),
  ledgerKey: { id, madeAt: NOW.toISOString() },
});

/** A pass of the execution: its own meter over the one ledger. */
const passOf = (ledger: InMemoryCostLedgerRepository, clock: VirtualClock): BudgetMeter =>
  new BudgetMeter([budget], ledger, clock, 0);

const spentOf = (ledger: InMemoryCostLedgerRepository, clock: VirtualClock) =>
  ledger.findSpentByCounter(counterOf(budget, clock.now()));

describe("#810: a spend of its own identity counts once across passes", () => {
  it("the price written by pass 1, then by pass 2 with the excess: 1 + 2, never 1 + 1 + 2", async () => {
    // the pass runs a minute after the spend was first made: the entry keeps its own date
    const ledger = new InMemoryCostLedgerRepository();
    const clock = new VirtualClock(new Date(NOW.getTime() + 60_000));
    const first = passOf(ledger, clock);
    const [price] = first.tally([keyed(1, "a2a:m-1:price")]);
    await first.settled();
    const second = passOf(ledger, clock);
    second.tally([keyed(1, "a2a:m-1:price"), keyed(2, "a2a:m-1:report")]);
    await second.settled();

    expect(price?.ledgerId).toBe("a2a:m-1:price");
    expect(price?.madeAt).toBe(NOW.toISOString());
    expect(await spentOf(ledger, clock)).toBeCloseTo(3);
  });

  it("both passes at once, each with both charges: 3", async () => {
    const [ledger, clock] = [new InMemoryCostLedgerRepository(), new VirtualClock(NOW)];
    const [a, b] = [passOf(ledger, clock), passOf(ledger, clock)];
    a.tally([keyed(1, "a2a:m-1:price"), keyed(2, "a2a:m-1:report")]);
    b.tally([keyed(2, "a2a:m-1:report"), keyed(1, "a2a:m-1:price")]);
    await Promise.all([a.settled(), b.settled()]);

    expect(await spentOf(ledger, clock)).toBeCloseTo(3);
  });

  it("another call's identity, or none, is another entry", async () => {
    const [ledger, clock] = [new InMemoryCostLedgerRepository(), new VirtualClock(NOW)];
    const [a, b] = [passOf(ledger, clock), passOf(ledger, clock)];
    a.tally([keyed(1, "a2a:m-1:price"), recordToolCost("pay-tool", 1)]);
    b.tally([keyed(1, "a2a:m-2:price"), recordToolCost("pay-tool", 1)]);
    await Promise.all([a.settled(), b.settled()]);

    expect(await spentOf(ledger, clock)).toBeCloseTo(4);
  });

  it("written at its step's end (no tally first) under its identity too", async () => {
    const [ledger, clock] = [new InMemoryCostLedgerRepository(), new VirtualClock(NOW)];
    await passOf(ledger, clock).record([keyed(1, "a2a:m-1:price")]);
    await passOf(ledger, clock).record([keyed(1, "a2a:m-1:price")]);

    expect(await spentOf(ledger, clock)).toBeCloseTo(1);
  });

  it("the pass counts its own keyed spend once: never taken in again as written elsewhere", async () => {
    const [ledger, clock] = [new InMemoryCostLedgerRepository(), new VirtualClock(NOW)];
    const pass = passOf(ledger, clock);
    const [kept] = pass.tally([keyed(1, "a2a:m-1:price")]);
    await pass.settled();
    // the step's end records what it tallied: in the ledger already, counted once
    await pass.record(kept === undefined ? [] : [kept]);
    await pass.refresh();

    expect(pass.remaining()).toBeCloseTo(99);
    expect(() => {
      pass.check(kept === undefined ? [] : [kept], []);
    }).not.toThrow();
    expect(await spentOf(ledger, clock)).toBeCloseTo(1);
  });

  it("a breach names what the execution spent once: its keyed spend not counted twice", async () => {
    const [ledger, clock] = [new InMemoryCostLedgerRepository(), new VirtualClock(NOW)];
    const tight = { ...budget, maxSpend: 1 };
    const pass = new BudgetMeter([tight], ledger, clock, 0);
    const [kept] = pass.tally([keyed(1.5, "a2a:m-1:price")]);
    await pass.settled();

    let thrown: unknown;
    try {
      pass.check(kept === undefined ? [] : [kept], []);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BudgetExceededError);
    expect((thrown as BudgetExceededError).spentUsd).toBeCloseTo(1.5);
  });
});
