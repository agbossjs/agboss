/**
 * #817 (money shard) — one ledger state on a usage record: `ledger` read back as kept (a
 * checkpoint's ISO date as a `Date`), a record kept before 0.1.1 (`isRecordedElsewhere`,
 * `ledgerId`, ISO `madeAt`) read as the same state — never written or counted again after an
 * upgrade — and every save of the meter an entry with its own identity, a step's end too.
 */
import { describe, expect, it } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import {
  BudgetMeter,
  counterOf,
  type ExecutionBudgetRecord,
} from "../../src/budgets/execution-budgets.js";
import {
  LedgerState,
  ledgerMarkOf,
  withoutLedgerMarks,
  writtenLedgerIdOf,
} from "../../src/finops/ledger-mark.js";
import { buildCostReport, recordToolCost, type UsageRecord } from "../../src/finops/usage.js";
import {
  InMemoryCostLedgerRepository,
  type CostCounter,
  type LedgerEntry,
} from "../../src/infrastructure/cost-ledger.repository.js";
import { VirtualClock } from "../../src/testing/index.js";
import { ledgerEntryOf } from "../helpers.js";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const budget: ExecutionBudgetRecord = {
  budget: { name: "execution-budget" },
  scope: BudgetScope.Execution,
  key: "execution-1",
  maxSpend: 100,
};

const paid = (costUsd: number): UsageRecord => recordToolCost("pay-tool", costUsd);

/** A record as a state of before 0.1.1 kept it: the three fields of #333, #727 and #771. */
const legacy = (fields: Record<string, unknown>): UsageRecord => ({ ...paid(1), ...fields });

/** A ledger that remembers every entry it was handed. */
class SeenLedger extends InMemoryCostLedgerRepository {
  readonly seen: LedgerEntry[] = [];

  override saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]) {
    this.seen.push(...entries);
    return super.saveAll(counters, entries);
  }
}

const clock = new VirtualClock(NOW);
const meterOf = (ledger: SeenLedger, counted: readonly UsageRecord[] = []): BudgetMeter =>
  new BudgetMeter([budget], ledger, clock, 0, undefined, counted);
const spentIn = (ledger: SeenLedger) => ledger.findSpentByCounter(counterOf(budget, NOW));

describe("#817: ledgerMarkOf reads the one state", () => {
  it("a record not in the ledger has none; a written one its id and Date; one recorded elsewhere its state", () => {
    const madeAt = new Date("2026-11-04T11:00:00.000Z");
    expect(ledgerMarkOf(paid(1))).toBeUndefined();
    expect(
      ledgerMarkOf({ ...paid(1), ledger: { state: LedgerState.Written, ledgerId: "p:0", madeAt } }),
    ).toEqual({ state: LedgerState.Written, ledgerId: "p:0", madeAt });
    expect(ledgerMarkOf({ ...paid(1), ledger: { state: LedgerState.RecordedElsewhere } })).toEqual({
      state: LedgerState.RecordedElsewhere,
    });
  });

  it("a checkpoint's mark — its date as ISO text, JSON round trip — reads back as a Date", () => {
    const kept: unknown = JSON.parse(
      JSON.stringify({
        ...paid(1),
        ledger: { state: LedgerState.Written, ledgerId: "p:1", madeAt: new Date(NOW) },
      }),
    );
    const mark = ledgerMarkOf(kept as UsageRecord);

    expect(mark).toEqual({ state: LedgerState.Written, ledgerId: "p:1", madeAt: NOW });
    expect(mark?.state === LedgerState.Written && mark.madeAt).toBeInstanceOf(Date);
  });

  it("a mark this version does not read fails closed — never read as not in the ledger, never as counted", () => {
    const unread = [
      { state: "written" },
      { state: LedgerState.Written, ledgerId: "", madeAt: NOW },
      { state: LedgerState.Written, ledgerId: "p:2", madeAt: "not a date" },
      { state: LedgerState.Written, ledgerId: "p:3", madeAt: 0 },
      { state: "recorded-later" },
      "written",
      null,
    ];
    for (const ledger of unread)
      expect(() => ledgerMarkOf({ ...paid(1), ledger })).toThrow(TypeError);
  });

  it("a cost report shows no mark of any version", () => {
    const report = buildCostReport([
      { ...paid(1), ledger: { state: LedgerState.Written, ledgerId: "p:4", madeAt: NOW } },
      legacy({ isRecordedElsewhere: true, ledgerId: "p:5", madeAt: NOW.toISOString() }),
    ]);
    for (const line of report.trace) {
      expect(line).not.toHaveProperty("ledger");
      expect(line).not.toHaveProperty("isRecordedElsewhere");
      expect(line).not.toHaveProperty("ledgerId");
      expect(line).not.toHaveProperty("madeAt");
    }
    expect(withoutLedgerMarks(paid(1))).toEqual(paid(1));
  });
});

describe("#817 AC3: a record kept before 0.1.1 reads as the same state", () => {
  it("isRecordedElsewhere with a ledgerId is written — dated by its ISO madeAt, or the epoch without one", () => {
    expect(
      ledgerMarkOf(
        legacy({ isRecordedElsewhere: true, ledgerId: "p:6", madeAt: "2026-11-04T10:00:00.000Z" }),
      ),
    ).toEqual({
      state: LedgerState.Written,
      ledgerId: "p:6",
      madeAt: new Date("2026-11-04T10:00:00.000Z"),
    });
    expect(ledgerMarkOf(legacy({ isRecordedElsewhere: true, ledgerId: "p:7" }))).toEqual({
      state: LedgerState.Written,
      ledgerId: "p:7",
      madeAt: new Date(0),
    });
    expect(writtenLedgerIdOf(legacy({ isRecordedElsewhere: true, ledgerId: "p:8" }))).toBe("p:8");
  });

  it("isRecordedElsewhere without one is recorded elsewhere; none of the fields is not in the ledger", () => {
    expect(ledgerMarkOf(legacy({ isRecordedElsewhere: true }))).toEqual({
      state: LedgerState.RecordedElsewhere,
    });
    expect(ledgerMarkOf(legacy({ isRecordedElsewhere: false }))).toBeUndefined();
  });

  it("a pass restored from a state of before writes none of its written records again, and counts each once", async () => {
    const ledger = new SeenLedger();
    // an earlier pass wrote $1 under its id; the state kept the record the old way
    const earlier = meterOf(ledger);
    const [written] = earlier.tally([paid(1)]);
    await earlier.settled();
    const ledgerId = written === undefined ? undefined : writtenLedgerIdOf(written);
    const kept = legacy({
      isRecordedElsewhere: true,
      ledgerId,
      madeAt: NOW.toISOString(),
    });
    const seen = ledger.seen.length;

    const restored = meterOf(ledger, [kept]);
    await restored.record([kept]);
    await restored.refresh();

    expect(ledger.seen.length).toBe(seen);
    expect(await spentIn(ledger)).toBe(1);
    expect(restored.remaining()).toBe(99);
  });

  it("a child's call recorded elsewhere the old way is taken in once, never written", async () => {
    const ledger = new SeenLedger();
    await ledger.saveAll([counterOf(budget, NOW)], [ledgerEntryOf(paid(2), "child:0", NOW)]);
    const child = legacy({ isRecordedElsewhere: true, costUsd: 2 });
    const meter = meterOf(ledger);
    const seen = ledger.seen.length;

    await meter.takeRecordedElsewhere([child]);
    await meter.record([child]);

    expect(ledger.seen.length).toBe(seen);
    expect(await spentIn(ledger)).toBe(2);
    expect(meter.remaining()).toBe(98);
  });
});

describe("#817: every save of the meter is a ledger entry", () => {
  it("spend written at its step's end is an entry of its own: an id of the pass, made now, its cost in Usd", async () => {
    const ledger = new SeenLedger();
    const meter = meterOf(ledger);

    await meter.record([paid(0.25), paid(0.25)]);

    expect(ledger.seen).toEqual([
      expect.objectContaining({ ledgerId: expect.any(String), madeAt: NOW, costUsd: 0.25 }),
      expect.objectContaining({ ledgerId: expect.any(String), madeAt: NOW, costUsd: 0.25 }),
    ]);
    expect(ledger.seen[0]?.ledgerId).not.toBe(ledger.seen[1]?.ledgerId);
    expect(await spentIn(ledger)).toBe(0.5);
  });

  it("a tally's entry carries the mark's id and date; the state's record its mark only", async () => {
    const ledger = new SeenLedger();
    const meter = meterOf(ledger);

    const [kept] = meter.tally([paid(1)]);
    await meter.settled();

    const mark = kept === undefined ? undefined : ledgerMarkOf(kept);
    expect(mark).toEqual({ state: LedgerState.Written, ledgerId: expect.any(String), madeAt: NOW });
    expect(ledger.seen).toEqual([
      expect.objectContaining({
        ledgerId: mark?.state === LedgerState.Written ? mark.ledgerId : "none",
        madeAt: NOW,
      }),
    ]);
    expect(kept).not.toHaveProperty("ledgerId");
  });
});
