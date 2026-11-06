import { describe, expectTypeOf, it } from "vitest";
import {
  CostCategory,
  CostLedgerRepository,
  CostSource,
  LedgerState,
  expiredEntriesOf,
  unrecordedEntriesOf,
  type CostCounter,
  type LedgerEntry,
  type LedgerMark,
  type UsageRecord,
} from "../../src/index.js";
import type { Usd } from "../../src/units/index.js";

/**
 * #817 AC1 / AC4 / AC5: the ledger's contract at compile time — only a `LedgerEntry` is saved, its
 * date a `Date` and its cost `Usd`; one ledger state on a usage record; the closed sets are enums.
 */

declare const ledger: CostLedgerRepository;
declare const counters: readonly CostCounter[];
declare const record: UsageRecord;
declare const entry: LedgerEntry;

describe("#817 AC1: saveAll takes ledger entries only", () => {
  it("a usage record without an identity does not compile", () => {
    // @ts-expect-error -- a record without ledgerId / madeAt could be counted on every retry
    void ledger.saveAll(counters, [record]);
    void ledger.saveAll(counters, [entry]);
  });

  it("an entry dated by ISO text or ms, or costing a plain number, does not compile", () => {
    // @ts-expect-error -- madeAt is a Date, never ISO text
    const text: LedgerEntry = { ...entry, madeAt: "2026-10-18T12:00:00.000Z" };
    // @ts-expect-error -- madeAt is a Date, never ms
    const ms: LedgerEntry = { ...entry, madeAt: 1_760_000_000_000 };
    // @ts-expect-error -- an amount crossing the store boundary is Usd
    const plain: LedgerEntry = { ...entry, costUsd: 0.25 };
    expectTypeOf([text, ms, plain]).toEqualTypeOf<LedgerEntry[]>();
  });

  it("a ledger entry is a usage record with its identity, date and Usd cost", () => {
    expectTypeOf<LedgerEntry>().toExtend<UsageRecord>();
    expectTypeOf<LedgerEntry["ledgerId"]>().toEqualTypeOf<string>();
    expectTypeOf<LedgerEntry["madeAt"]>().toEqualTypeOf<Date>();
    expectTypeOf<LedgerEntry["costUsd"]>().toEqualTypeOf<Usd>();
  });
});

describe("#817 AC4: Date and Usd at the store boundary", () => {
  it("findSpentByCounter answers Usd; deleteByMadeAtBefore takes a Date", () => {
    expectTypeOf<CostLedgerRepository["findSpentByCounter"]>().returns.toEqualTypeOf<
      Promise<Usd>
    >();
    expectTypeOf<CostLedgerRepository["deleteByMadeAtBefore"]>().parameter(0).toEqualTypeOf<Date>();
  });

  it("the store helpers take and give Date", () => {
    expectTypeOf(unrecordedEntriesOf).parameter(1).parameter(1).toEqualTypeOf<Date>();
    expectTypeOf(unrecordedEntriesOf).returns.toEqualTypeOf<readonly LedgerEntry[]>();
    expectTypeOf(expiredEntriesOf).parameter(1).toEqualTypeOf<Date | undefined>();
  });
});

describe("#817: one ledger state on a usage record", () => {
  it("the old fields do not compile; a written mark needs its id and date", () => {
    // @ts-expect-error -- isRecordedElsewhere is gone: `ledger` holds the state
    const old: UsageRecord = { ...record, isRecordedElsewhere: true };
    // @ts-expect-error -- a written mark has its ledgerId and madeAt
    const bare: LedgerMark = { state: LedgerState.Written };
    const written: LedgerMark = { state: LedgerState.Written, ledgerId: "a:0", madeAt: new Date() };
    const elsewhere: LedgerMark = { state: LedgerState.RecordedElsewhere };
    expectTypeOf([old, bare, written, elsewhere]).toExtend<unknown[]>();
  });
});

describe("#817 AC5: the closed sets are enums", () => {
  it("a string literal is no CostSource; a report's categories are keyed by CostCategory", () => {
    // @ts-expect-error -- CostSource is an enum
    const source: CostSource = "api";
    const api: CostSource = CostSource.Api;
    expectTypeOf<`${CostCategory}`>().toEqualTypeOf<
      "agents" | "routing" | "guards" | "review" | "tools" | "compaction" | "retrieval"
    >();
    expectTypeOf([source, api]).toEqualTypeOf<CostSource[]>();
  });
});
