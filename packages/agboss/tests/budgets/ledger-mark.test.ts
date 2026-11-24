import { usd } from "../../src/units/index.js";
import { StoredNamesUnreadableError } from "../../src/core/stored-json.js";
/**
 * #817 (money shard) — one ledger state on a usage record: `ledger` read back as kept (a
 * checkpoint's ISO date as a `Date`; no 0.1.0 field is read), and every save of the meter an entry with its own identity, a step's end too.
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
  withLedgerMarkRead,
  withoutLedgerMarks,
  writtenLedgerIdOf,
  writtenLedgerIdsOf,
} from "../../src/finops/ledger-mark.js";
import { CostReport, recordToolCost, type UsageRecord } from "../../src/finops/usage.js";
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
const spentIn = (ledger: SeenLedger) =>
  ledger.findUsageByCounter(counterOf(budget, NOW)).then((usage) => usage.spent);

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
      { state: LedgerState.Written, ledgerId: "p:9" },
      { state: "written-later", ledgerId: "p:16", madeAt: NOW },
      { state: LedgerState.Written, ledgerId: 42, madeAt: NOW },
      { state: LedgerState.Written, ledgerId: 42, madeAt: NOW.toISOString() },
      { state: LedgerState.Written, ledgerId: "p:15", madeAt: Date.parse("2026-11-04") },
      { state: LedgerState.Written, ledgerId: "p:10", madeAt: "garbage 12" },
      { state: LedgerState.Written, ledgerId: "p:11", madeAt: "2026-11-04" },
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
    const report = CostReport.fromUsage([
      { ...paid(1), ledger: { state: LedgerState.Written, ledgerId: "p:4", madeAt: NOW } },
      { ...paid(1), ledger: { state: LedgerState.RecordedElsewhere } },
    ]);
    for (const line of report.trace) {
      expect(line).not.toHaveProperty("ledger");
      expect(line).not.toHaveProperty("ledgerId");
      expect(line).not.toHaveProperty("madeAt");
    }
    expect(withoutLedgerMarks(paid(1))).toEqual(paid(1));
  });
});

describe("D3: a record of 0.1.0's mark is refused, never read as not in the ledger", () => {
  it.each([
    [{ isRecordedElsewhere: true }, "isRecordedElsewhere"],
    [{ isRecordedElsewhere: false }, "isRecordedElsewhere"],
    [{ ledgerId: "p:1" }, "ledgerId"],
    [{ madeAt: "2026-11-04T10:00:00.000Z" }, "madeAt"],
    [
      { isRecordedElsewhere: true, ledgerId: "p:2", madeAt: NOW.toISOString() },
      "isRecordedElsewhere, ledgerId, madeAt",
    ],
  ])("%o", (fields, names) => {
    const record = { ...paid(1), ...fields };

    for (const read of [
      () => ledgerMarkOf(record),
      () => writtenLedgerIdOf(record),
      () => withLedgerMarkRead(record),
    ]) {
      expect(read).toThrow(StoredNamesUnreadableError);
      expect(read).toThrow(names);
    }
  });
});

describe("#1353 writtenLedgerIdsOf", () => {
  it("writtenLedgerIdsOf names the ids of the written records only, in order (#1353)", () => {
    const written = (ledgerId: string): UsageRecord => ({
      ...paid(1),
      ledger: { state: LedgerState.Written, ledgerId, madeAt: NOW },
    });
    const elsewhere: UsageRecord = { ...paid(1), ledger: { state: LedgerState.RecordedElsewhere } };

    expect(writtenLedgerIdsOf([written("p:1"), paid(1), elsewhere, written("p:2")])).toEqual([
      "p:1",
      "p:2",
    ]);
    expect(writtenLedgerIdsOf([paid(1), elsewhere])).toEqual([]);
    expect(writtenLedgerIdsOf([])).toEqual([]);
  });
});

describe("#817: every save of the meter is a ledger entry", () => {
  it("spend written at its step's end is an entry of its own: an id of the pass, made now, its cost in Usd", async () => {
    const ledger = new SeenLedger();
    const meter = meterOf(ledger);

    await meter.record([paid(0.25), paid(0.25)]);

    expect(ledger.seen).toEqual([
      expect.objectContaining({ ledgerId: expect.any(String), madeAt: NOW, costUsd: usd(0.25) }),
      expect.objectContaining({ ledgerId: expect.any(String), madeAt: NOW, costUsd: usd(0.25) }),
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

describe("#817: a record read back with its mark as this version keeps it", () => {
  it("a checkpoint's ISO date is a Date again; the fields of before become the one mark", () => {
    const written = JSON.parse(
      JSON.stringify({
        ...paid(1),
        ledger: { state: LedgerState.Written, ledgerId: "p:20", madeAt: NOW },
      }),
    ) as UsageRecord;

    expect(withLedgerMarkRead(written)).toEqual({
      ...paid(1),
      ledger: { state: LedgerState.Written, ledgerId: "p:20", madeAt: NOW },
    });
    const bare = paid(1);
    expect(withLedgerMarkRead(bare)).toBe(bare);
  });

  it("#810: a spend's ledgerKey kept by a checkpoint reads back with its Date; one it cannot read fails closed", () => {
    const keyed = JSON.parse(
      JSON.stringify({ ...paid(1), ledgerKey: { id: "a2a:m-1:price", madeAt: NOW } }),
    ) as UsageRecord;

    expect(withLedgerMarkRead(keyed)).toEqual({
      ...paid(1),
      ledgerKey: { id: "a2a:m-1:price", madeAt: NOW },
    });
    for (const ledgerKey of [
      { id: "a2a:m-1:price", madeAt: "yesterday" },
      { id: "", madeAt: NOW.toISOString() },
      { madeAt: NOW.toISOString() },
      "a2a:m-1:price",
      null,
    ])
      expect(() => withLedgerMarkRead({ ...paid(1), ledgerKey })).toThrow(TypeError);
    expect(() => withLedgerMarkRead({ ...paid(1), ledgerKey: "a2a:m-1:price" })).toThrow(
      `a usage record's ledgerKey is not one this version reads: "a2a:m-1:price"`,
    );
  });

  it("#810: a record whose ledgerKey is there but undefined (a state not yet kept) reads back as it is", () => {
    const unkeyed = { ...paid(1), ledgerKey: undefined };

    expect(withLedgerMarkRead(unkeyed)).toBe(unkeyed);
    expect(
      withLedgerMarkRead({
        ...unkeyed,
        ledger: { state: LedgerState.Written, ledgerId: "p:30", madeAt: NOW },
      }),
    ).toEqual({
      ...unkeyed,
      ledger: { state: LedgerState.Written, ledgerId: "p:30", madeAt: NOW },
    });
  });

  it("#810: a cost report shows no ledgerKey", () => {
    const report = CostReport.fromUsage([
      { ...paid(1), ledgerKey: { id: "a2a:m-1:price", madeAt: NOW } },
    ]);
    for (const line of report.trace) expect(line).not.toHaveProperty("ledgerKey");
  });
});

describe("#817: why a mark is not read", () => {
  it.each([
    [
      { ledger: { state: "recorded-later" } },
      `a usage record's ledger mark is not one this version reads: {"state":"recorded-later"}`,
    ],
    [
      { ledger: { state: LedgerState.Written, ledgerId: "p:30", madeAt: "garbage 12" } },
      "the ledger entry p:30 has no valid madeAt: garbage 12",
    ],
    [
      { ledger: { state: LedgerState.Written, ledgerId: "p:31" } },
      "the ledger entry p:31 has no valid madeAt: undefined",
    ],
    [
      { ledger: { state: LedgerState.Written, ledgerId: "p:32", madeAt: new Date(Number.NaN) } },
      "the ledger entry p:32 has no valid madeAt: Invalid Date",
    ],
    [{ ledger: null }, "a usage record's ledger mark is not one this version reads: null"],
    [
      { ledger: "written" },
      `a usage record's ledger mark is not one this version reads: "written"`,
    ],
    [
      { ledger: { state: LedgerState.Written, ledgerId: "p:35", madeAt: 1762250400000 } },
      "the ledger entry p:35 has no valid madeAt: 1762250400000",
    ],
  ])("%o", (fields, message) => {
    expect(() => ledgerMarkOf({ ...paid(1), ...fields })).toThrow(new TypeError(message));
  });

  it("a Date of the mark is taken as it is; ISO text only as a Date writes it", () => {
    const madeAt = new Date("2026-11-04T10:00:00.000Z");
    const mark = ledgerMarkOf({
      ...paid(1),
      ledger: { state: LedgerState.Written, ledgerId: "p:33", madeAt },
    });

    expect(mark?.state === LedgerState.Written ? mark.madeAt : undefined).toBe(madeAt);
    expect(() =>
      ledgerMarkOf({
        ...paid(1),
        ledger: { state: LedgerState.Written, ledgerId: "p:34", madeAt: "2026-11-04T10:00:00Z" },
      }),
    ).toThrow(TypeError);
  });
});
