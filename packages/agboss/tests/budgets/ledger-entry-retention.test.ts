/**
 * #771 — the ledger's entries are pruned by the recovery sweep after `retention.costLedgerEntries`, and a
 * write of one the ledger may have pruned is refused, never counted again: a lost answer retried
 * within the retention counts once; one retried after the sweep pruned its entry fails the pass's
 * reads with `CostLedgerEntryExpiredError` and the ledger still holds the spend once.
 */
import { describe, expect, it } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import { counterOf, meterOf, type BudgetMeter } from "../../src/budgets/execution-budgets.js";
import { LedgerState, writtenLedgerIdOf } from "../../src/finops/ledger-mark.js";
import { recordToolCost } from "../../src/finops/usage.js";
import { ledgerEntryOf } from "../helpers.js";
import {
  CostLedgerEntryExpiredError,
  InMemoryCostLedgerRepository,
  type CostCounter,
  type LedgerEntry,
} from "../../src/infrastructure/cost-ledger.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { removeExpired } from "../../src/infrastructure/recovery.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, minutes, type Milliseconds } from "../../src/units/index.js";

const budget = {
  budget: { name: "execution-budget" },
  scope: BudgetScope.Execution,
  key: "execution-1",
  maxSpend: 100,
};

/** A ledger whose first write is kept but answers with an error: its answer was lost. */
class LostAnswerLedger extends InMemoryCostLedgerRepository {
  isAnswerLost = true;

  override async saveAll(counters: readonly CostCounter[], records: readonly LedgerEntry[]) {
    await super.saveAll(counters, records);
    if (!this.isAnswerLost) return;
    this.isAnswerLost = false;
    throw new Error("the connection reset after the commit");
  }
}

/** A pass that tallied $40 at the clock's now and lost the write's answer. */
async function passWithLostAnswer(clock: VirtualClock, ledger: LostAnswerLedger) {
  const meter: BudgetMeter = meterOf({ ledger, clock }, [budget], 0);
  const [kept] = meter.tally([recordToolCost("pay-tool", 40)]);
  // the write landed; its answer was lost — the tally keeps it for a retry
  await expect.poll(() => ledger.isAnswerLost).toBe(false);
  return { meter, kept };
}

/** One look of the recovery sweep at the clock's now, with `retention` for the ledger's entries. */
const sweep = (
  clock: VirtualClock,
  ledger: InMemoryCostLedgerRepository,
  retention: Milliseconds,
) =>
  removeExpired(
    {
      clock,
      pauses: new InMemoryPausedExecutionRepository(),
      pauseRecordRetention: hours(24),
      ledger,
      ledgerEntryRetention: retention,
    },
    (text) => {
      throw new Error(text);
    },
  );

const spentIn = (ledger: InMemoryCostLedgerRepository, clock: VirtualClock) =>
  ledger.findSpentByCounter(counterOf(budget, clock.now()));

describe("#771: a lost answer retried around the sweep's prune", () => {
  it("within the retention, the sweep keeps the entry: the retry counts it once", async () => {
    const clock = new VirtualClock();
    const ledger = new LostAnswerLedger();
    const { meter, kept } = await passWithLostAnswer(clock, ledger);

    await clock.advance(hours(23));
    await sweep(clock, ledger, hours(24));
    await meter.settled();
    await meter.refresh();

    expect(await spentIn(ledger, clock)).toBe(40);
    expect(meter.remaining()).toBe(60);
    expect(kept?.ledger).toEqual({
      state: LedgerState.Written,
      ledgerId: expect.any(String),
      madeAt: new Date("2026-01-05T09:00:00.000Z"),
    });
  });

  it("past the retention, the sweep prunes it and the retry is refused: never counted twice", async () => {
    const clock = new VirtualClock();
    const ledger = new LostAnswerLedger();
    const { meter, kept } = await passWithLostAnswer(clock, ledger);

    // the pass slept a day and a minute; the sweep pruned what was made before a day ago
    await clock.advance(minutes(24 * 60 + 1));
    await sweep(clock, ledger, hours(24));

    await expect(meter.settled()).rejects.toBeInstanceOf(CostLedgerEntryExpiredError);
    await expect(meter.refresh()).rejects.toMatchObject({
      name: "CostLedgerEntryExpiredError",
      code: "cost-ledger.entry-expired",
      ledgerIds: [kept === undefined ? undefined : writtenLedgerIdOf(kept)],
      prunedBefore: new Date(clock.now().getTime() - hours(24)),
    });
    expect(await spentIn(ledger, clock)).toBe(40);
  });

  it("a spend made after the prune's cutoff is written and counted as ever", async () => {
    const clock = new VirtualClock();
    const ledger = new InMemoryCostLedgerRepository();
    const meter = meterOf({ ledger, clock }, [budget], 0);
    await clock.advance(hours(25));
    await sweep(clock, ledger, hours(24));

    meter.tally([recordToolCost("pay-tool", 25)]);
    await meter.settled();
    await sweep(clock, ledger, hours(24));
    await meter.refresh();

    expect(await spentIn(ledger, clock)).toBe(25);
    expect(meter.remaining()).toBe(75);
  });
});

describe("#771: the in-memory ledger's refusal", () => {
  it("names every refused entry once and the mark, and adds nothing", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const counter = counterOf(budget, new Date("2026-10-18T10:00:00.000Z"));
    const made = (ledgerId: string): LedgerEntry =>
      ledgerEntryOf(recordToolCost("pay-tool", 1), ledgerId, new Date("2026-10-18T08:00:00.000Z"));
    await ledger.deleteByMadeAtBefore(new Date("2026-10-18T09:00:00.000Z"));

    await expect(
      ledger.saveAll([counter], [made("a:0"), made("a:1"), made("a:0")]),
    ).rejects.toThrow(
      "the ledger may have pruned the entries a:0, a:1: made before its pruning mark 2026-10-18T09:00:00.000Z and not held, counting them again could count them twice — the save added nothing; keep entries longer with @Application({ retention: { costLedgerEntries } })",
    );
    expect(await ledger.findSpentByCounter(counter)).toBe(0);
  });
});
