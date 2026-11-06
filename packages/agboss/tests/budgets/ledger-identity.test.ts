/**
 * #727 — a ledger identity is the pass's own, never derived from where the spend was made: a later
 * pass that makes spend again in the same step (after a crash, a takeover) was billed again and
 * counts again; a record an earlier pass kept — reaching this pass from a durable state — carries
 * the id the ledger has and counts once; and a write retried after its answer was lost counts once
 * — in the ledger, and in the pass's own checks before it is retried (#770).
 */
import { describe, expect, it } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import { counterOf, meterOf, type BudgetMeter } from "../../src/budgets/execution-budgets.js";
import { recordToolCost, type UsageRecord } from "../../src/finops/usage.js";
import {
  InMemoryCostLedgerRepository,
  type CostCounter,
  type LedgerEntry,
} from "../../src/infrastructure/cost-ledger.repository.js";
import { systemClock } from "../../src/infrastructure/clock.js";
import { inTestFrame } from "../helpers/frame.js";

const budget = {
  budget: { name: "execution-budget" },
  scope: BudgetScope.Execution,
  key: "execution-1",
  maxSpend: 100,
};

const paid = (): UsageRecord => recordToolCost("pay-tool", 1);

/** A pass of the tree: a meter of its own, on the one ledger. */
const passOn = (ledger: InMemoryCostLedgerRepository): BudgetMeter =>
  meterOf({ ledger, clock: systemClock }, [budget], 0);

const spentIn = (ledger: InMemoryCostLedgerRepository) =>
  ledger.findSpentByCounter(counterOf(budget, systemClock.now()));

/** A ledger whose next write is kept but answers with an error: its answer was lost. */
class LostAnswerLedger extends InMemoryCostLedgerRepository {
  isAnswerLost = true;

  override async saveAll(counters: readonly CostCounter[], records: readonly LedgerEntry[]) {
    await super.saveAll(counters, records);
    if (!this.isAnswerLost) return;
    this.isAnswerLost = false;
    throw new Error("the connection reset after the commit");
  }
}

describe("#727: a ledger identity is the pass's own", () => {
  it("a later pass's spend in the same step counts again; the earlier pass's kept record once", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const frozen = passOn(ledger);
    const later = passOn(ledger);

    await inTestFrame(async () => {
      const [kept] = frozen.tally([paid()]);
      await frozen.settled();
      // the later pass runs the same step again: billed again, in the same frame
      later.tally([paid()]);
      await later.settled();
      // and the frozen pass's record reaches it from the step's durable writes
      await later.record(kept === undefined ? [] : [kept]);
    });

    expect(await spentIn(ledger)).toBe(2);
  });

  it("a write whose answer was lost, written again, counts once", async () => {
    const ledger = new LostAnswerLedger();
    const meter = meterOf({ ledger, clock: systemClock }, [budget], 0);

    meter.tally([paid()]);
    await meter.settled();

    expect(await spentIn(ledger)).toBe(1);
  });

  it("#770: a write whose answer was lost is counted once by the pass's next read, before it is retried", async () => {
    const ledger = new LostAnswerLedger();
    const meter = meterOf({ ledger, clock: systemClock }, [budget], 0);

    // $40 kept by the ledger, its answer lost; then $25, written with a read that holds both
    const kept = [...meter.tally([recordToolCost("pay-tool", 40)])];
    kept.push(...meter.tally([recordToolCost("pay-tool", 25)]));
    await meter.refresh();

    // $65 of $100: the check passes, $35 left — not $105 with the lost answer's $40 counted twice
    expect(() => {
      meter.check(kept, []);
    }).not.toThrow();
    expect(meter.remaining()).toBe(35);
    await meter.settled();
    expect(meter.remaining()).toBe(35);
    expect(await spentIn(ledger)).toBe(65);
  });
});
