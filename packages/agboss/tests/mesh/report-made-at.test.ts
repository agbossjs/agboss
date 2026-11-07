/**
 * #810 (security review) — the ledger date of a run report's charge is never the peer's word
 * alone: its signed `issuedAt` is clamped into the caller's own window, from the call's stored
 * accept to the caller's `now`. A backdated report (the epoch, or before the call was accepted)
 * cannot hide the spend behind a budget's period or the ledger's pruning mark, a future one cannot
 * keep it from them, an unreadable one is dated `now` — and in every case the charge, written by two
 * passes, counts once.
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
import { reportMadeAtOf } from "../../src/mesh/mesh-report.js";
import { VirtualClock } from "../../src/testing/index.js";

const ACCEPTED = "2026-11-04T12:00:00.000Z";
const NOW = new Date("2026-11-04T12:05:00.000Z");
const WINDOW = { notBefore: ACCEPTED, now: NOW };

const budget: ExecutionBudgetRecord = {
  budget: { name: "execution-budget" },
  scope: BudgetScope.Execution,
  key: "execution-1",
  maxSpend: 100,
};

const inWindow = (madeAt: string): boolean => {
  const at = Date.parse(madeAt);
  return at >= Date.parse(ACCEPTED) && at <= NOW.getTime();
};

const ISSUED = {
  backdated: "1970-01-01T00:00:00.000Z",
  "before the accept": "2026-11-04T11:59:59.000Z",
  future: "2030-01-01T00:00:00.000Z",
  NaN: "not a date",
  "in range": "2026-11-04T12:03:00.000Z",
} as const;

describe("#810: a run report's charge is dated inside the caller's window", () => {
  it("backdated to the epoch → the accept's time", () => {
    expect(reportMadeAtOf(ISSUED.backdated, WINDOW)).toBe(ACCEPTED);
  });

  it("before the call was accepted → the accept's time", () => {
    expect(reportMadeAtOf(ISSUED["before the accept"], WINDOW)).toBe(ACCEPTED);
  });

  it("in the future → now", () => {
    expect(reportMadeAtOf(ISSUED.future, WINDOW)).toBe(NOW.toISOString());
  });

  it("no date (NaN), or none at all → now", () => {
    expect(reportMadeAtOf(ISSUED.NaN, WINDOW)).toBe(NOW.toISOString());
    expect(reportMadeAtOf(undefined, WINDOW)).toBe(NOW.toISOString());
  });

  it("in range → the report's own date", () => {
    expect(reportMadeAtOf(ISSUED["in range"], WINDOW)).toBe(ISSUED["in range"]);
  });

  it("a lower bound that is no date, or past now, leaves only now (fail closed)", () => {
    expect(reportMadeAtOf(ISSUED.backdated, { notBefore: "x", now: NOW })).toBe(NOW.toISOString());
    const later = { notBefore: "2026-11-04T13:00:00.000Z", now: NOW };
    expect(reportMadeAtOf(ISSUED.backdated, later)).toBe(NOW.toISOString());
  });

  it.each(Object.entries(ISSUED))(
    "%s: written by two passes, in the window, counted once",
    async (_name, issuedAt) => {
      const [ledger, clock] = [new InMemoryCostLedgerRepository(), new VirtualClock(NOW)];
      const charge = (now: Date): UsageRecord => ({
        ...recordToolCost("pay-tool", 2),
        ledgerKey: {
          id: "a2a:m-1:report",
          madeAt: reportMadeAtOf(issuedAt, { notBefore: ACCEPTED, now }),
        },
      });
      const first = new BudgetMeter([budget], ledger, clock, 0);
      const [kept] = first.tally([charge(NOW)]);
      await first.settled();
      // the takeover settles a minute later: an in-window date is the same, an unreadable one moves
      const second = new BudgetMeter([budget], ledger, clock, 0);
      second.tally([charge(new Date(NOW.getTime() + 60_000))]);
      await second.settled();

      expect(inWindow(kept?.madeAt ?? "")).toBe(true);
      expect(await ledger.findSpentByCounter(counterOf(budget, clock.now()))).toBeCloseTo(2);
    },
  );
});
