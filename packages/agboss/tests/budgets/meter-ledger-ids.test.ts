/**
 * #727 (money shard) — the meter's ledger identities, one round trip at a time: what a tally writes
 * and marks, when `settled` resolves, a failed write written again, what an earlier pass wrote
 * (restored into this pass's state, or in what it spent before) counted once, and what was taken
 * in as written elsewhere never taken in twice.
 */
import { describe, expect, it, vi } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import {
  BudgetMeter,
  counterOf,
  NO_BUDGET_CHECK,
  type ExecutionBudgetRecord,
} from "../../src/budgets/execution-budgets.js";
import { recordToolCost, type UsageRecord } from "../../src/finops/usage.js";
import { BudgetExceededError } from "../../src/graph/limits.js";
import {
  InMemoryCostLedgerRepository,
  type CostCounter,
  type LedgerEntry,
} from "../../src/infrastructure/cost-ledger.repository.js";
import { VirtualClock } from "../../src/testing/index.js";
import type { Usd } from "../../src/units/index.js";
import { LedgerState } from "../../src/finops/ledger-mark.js";

const NOW = new Date("2026-11-04T12:00:00.000Z");

/** A zero limit: every check throws, naming what the counter holds. */
const budget: ExecutionBudgetRecord = {
  budget: { name: "execution-budget" },
  scope: BudgetScope.Execution,
  key: "execution-1",
  maxSpend: 0,
};
const roomy = { ...budget, maxSpend: 100 };

const paid = (costUsd: number): UsageRecord => recordToolCost("pay-tool", costUsd);

/** A ledger that counts its reads, can hold its writes and can fail its next one. */
class ScriptedLedger extends InMemoryCostLedgerRepository {
  reads = 0;
  saved = 0;
  failures = 0;
  held: Promise<void> | undefined;
  /** Each write waits for the next of these, when there is one. */
  readonly holds: Promise<void>[] = [];

  override findSpentByCounter(counter: CostCounter): Promise<Usd> {
    this.reads += 1;
    return super.findSpentByCounter(counter);
  }

  override async saveAll(counters: readonly CostCounter[], records: readonly LedgerEntry[]) {
    if (this.held !== undefined) await this.held;
    const hold = this.holds.shift();
    if (hold !== undefined) await hold;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("the ledger is down");
    }
    await super.saveAll(counters, records);
    this.saved += 1;
  }
}

const clock = new VirtualClock(NOW);
const meterOf = (
  ledger: ScriptedLedger,
  record = budget,
  spentBefore = 0,
  counted: readonly UsageRecord[] = [],
): BudgetMeter => new BudgetMeter([record], ledger, clock, spentBefore, undefined, counted);

const counted = (ledger: ScriptedLedger): Promise<Usd> =>
  ledger.findSpentByCounter(counterOf(budget, NOW));

/** What a check counts for the budget, and the execution's total it names. */
function checked(meter: BudgetMeter, state: readonly UsageRecord[]) {
  try {
    meter.check(state, []);
  } catch (error) {
    if (error instanceof BudgetExceededError)
      return { spent: error.spent, executionSpent: error.spentUsd };
    throw error;
  }
  throw new Error("a zero limit always throws");
}

/** An earlier pass's spend, tallied and written: the record its state keeps. */
async function writtenBy(ledger: ScriptedLedger, costUsd: number): Promise<UsageRecord> {
  const earlier = meterOf(ledger, roomy);
  const [kept] = earlier.tally([paid(costUsd)]);
  await earlier.settled();
  if (kept === undefined) throw new Error("a tally keeps its record");
  return kept;
}

describe("#727: the meter's ledger identities", () => {
  it("a tally writes once and marks what it keeps; a marked record tallied again writes nothing", async () => {
    const ledger = new ScriptedLedger();
    const meter = meterOf(ledger, roomy);

    const [kept] = meter.tally([paid(1)]);
    await meter.settled();
    const again = meter.tally(kept === undefined ? [] : [kept]);
    await meter.settled();

    expect(kept?.ledger).toMatchObject({
      state: LedgerState.Written,
      ledgerId: expect.any(String),
    });
    expect(again).toEqual([kept]);
    expect(await counted(ledger)).toBe(1);
    expect(NO_BUDGET_CHECK.tally([paid(1)])).toEqual([paid(1)]);
  });

  it("settled resolves only once the tally's write is in the ledger", async () => {
    const ledger = new ScriptedLedger();
    let release = (): void => undefined;
    ledger.held = new Promise((resolve) => {
      release = resolve;
    });
    const meter = meterOf(ledger, roomy);
    let isSettled = false;

    meter.tally([paid(1)]);
    const settled = meter.settled().then(() => {
      isSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    const wasSettled = isSettled;
    release();
    await settled;

    expect(wasSettled).toBe(false);
    expect(await counted(ledger)).toBe(1);
  });

  it("a write that failed is written by the next settle; one that fails again rejects it", async () => {
    const ledger = new ScriptedLedger();
    const meter = meterOf(ledger, roomy);
    ledger.failures = 1;

    meter.tally([paid(1)]);
    await meter.settled();
    expect(await counted(ledger)).toBe(1);

    ledger.failures = 2;
    meter.tally([paid(2)]);
    await expect(meter.settled()).rejects.toThrow("the ledger is down");
    await meter.settled();
    expect(await counted(ledger)).toBe(3);
  });

  it("a tally waiting for its write is still counted once an earlier one's write lands", async () => {
    const ledger = new ScriptedLedger();
    const meter = meterOf(ledger, roomy);
    meter.tally([paid(1)]);
    await meter.settled();
    let release = (): void => undefined;
    ledger.holds.push(
      Promise.resolve(),
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    meter.tally([paid(4)]);
    meter.tally([paid(8)]);
    await vi.waitFor(() => {
      expect(ledger.saved).toBe(2);
    });
    const whileHeld = meter.remaining();
    release();
    await meter.settled();

    expect(whileHeld).toBeCloseTo(87);
    expect(meter.remaining()).toBeCloseTo(87);
  });

  it("a tally of spend marked and not: only the unmarked is marked and written", async () => {
    const ledger = new ScriptedLedger();
    const meter = meterOf(ledger, roomy);
    const [kept] = meter.tally([paid(1)]);
    await meter.settled();

    const mixed = meter.tally([...(kept === undefined ? [] : [kept]), paid(2)]);
    await meter.settled();

    expect(mixed[0]).toBe(kept);
    expect(await counted(ledger)).toBe(3);
  });

  it("spend an earlier pass wrote, restored into this pass's state: every read holds it, counted once", async () => {
    const ledger = new ScriptedLedger();
    const restored = await writtenBy(ledger, 1);
    const meter = meterOf(ledger);
    await meter.refresh();

    expect(checked(meter, [restored]).spent).toBe(1);
    // beside spend written only when its step ends: the two, once each
    expect(checked(meter, [restored, paid(5)]).spent).toBe(6);
  });

  it("spend an earlier pass wrote, in what this pass spent before: counted once, beside the state's unwritten spend", async () => {
    const ledger = new ScriptedLedger();
    const before = await writtenBy(ledger, 1);
    const meter = meterOf(ledger, budget, 1, [before]);
    await meter.refresh();

    expect(checked(meter, [before, paid(5)]).spent).toBe(6);
  });

  it("spend taken in as written elsewhere: its record reaching the state takes nothing in again", async () => {
    const ledger = new ScriptedLedger();
    const elsewhere = await writtenBy(ledger, 1);
    const meter = meterOf(ledger);

    await meter.takeRecordedElsewhere([elsewhere]);
    const reads = ledger.reads;
    await meter.record([elsewhere]);

    expect(ledger.reads).toBe(reads);
    expect(checked(meter, [elsewhere])).toEqual({ spent: 1, executionSpent: 1 });
  });

  it("one record written elsewhere, reaching the state twice at once: taken in once", async () => {
    const ledger = new ScriptedLedger();
    const elsewhere = await writtenBy(ledger, 1);
    const meter = meterOf(ledger);

    await meter.record([elsewhere, elsewhere]);

    expect(checked(meter, [elsewhere])).toEqual({ spent: 1, executionSpent: 1 });
  });
});
