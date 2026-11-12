/**
 * #817 (money shard) — the ledger's store helpers, one at a time: what `assertLedgerEntries`
 * refuses and says, a date that is no date refused as a cutoff or a mark, what `expiredEntriesOf`
 * and `unrecordedEntriesOf` give.
 */
import { describe, expect, it } from "vitest";
import { ledgerEntryOf } from "../../src/budgets/budget-check.js";
import { recordToolCost } from "../../src/finops/usage.js";
import {
  assertLedgerCutoff,
  assertLedgerEntries,
  assertValidDate,
  expiredEntriesOf,
  invalidDateErrorOf,
  InMemoryCostLedgerRepository,
  invalidLedgerEntryErrorOf,
  unrecordedEntriesOf,
} from "../../src/infrastructure/cost-ledger.repository.js";
import {
  CostLedgerCutoffInvalidError,
  CostLedgerEntryExpiredError,
  CostLedgerEntryInvalidError,
} from "../../src/finops/ledger-mark.js";
import { SqliteCostLedgerRepository } from "../../src/infrastructure/sqlite/sqlite-cost-ledger.repository.js";
import { connectionTo, temporarySqlitePath } from "../infrastructure/contracts/store-kinds.js";

const MADE_AT = new Date("2026-11-04T12:00:00.000Z");
const fine = ledgerEntryOf(recordToolCost("pay-tool", 0.25), "p:0", MADE_AT);

describe("#817: assertLedgerEntries refuses anything but a ledger entry, naming why", () => {
  const cases: readonly (readonly [unknown, string])[] = [
    [null, "it is not an object"],
    ["p:1", "it is not an object"],
    [{ ...fine, ledgerId: undefined }, "it has no ledgerId"],
    [{ ...fine, ledgerId: "" }, "it has no ledgerId"],
    [{ ...fine, ledgerId: 7 }, "it has no ledgerId"],
    [
      { ...fine, madeAt: MADE_AT.toISOString() },
      "its madeAt is no valid Date: 2026-11-04T12:00:00.000Z",
    ],
    [{ ...fine, madeAt: new Date(Number.NaN) }, "its madeAt is no valid Date: Invalid Date"],
    [{ ...fine, costUsd: "0.25" }, "its costUsd is no finite amount ≥ 0: 0.25"],
    [
      { ...fine, costUsd: Number.POSITIVE_INFINITY },
      "its costUsd is no finite amount ≥ 0: Infinity",
    ],
    [{ ...fine, costUsd: -0.25 }, "its costUsd is no finite amount ≥ 0: -0.25"],
    [{ ...fine, costUsd: undefined }, "its costUsd is no finite amount ≥ 0: undefined"],
  ];

  it.each(cases)("%o: %s", (entry, reason) => {
    const refused = invalidLedgerEntryErrorOf([fine, entry]);

    expect(refused).toBeInstanceOf(CostLedgerEntryInvalidError);
    expect(refused).toMatchObject({
      code: "cost-ledger.entry-invalid",
      name: "CostLedgerEntryInvalidError",
      index: 1,
      reason,
      message: `the ledger was handed no ledger entry at index 1: ${reason} — the save added nothing; save only LedgerEntry values (an id, a madeAt Date, a costUsd in Usd)`,
    });
    expect(() => {
      assertLedgerEntries([fine, entry]);
    }).toThrow(refused?.message);
  });

  it("entries, a free cost and none at all pass", () => {
    const free = ledgerEntryOf(recordToolCost("free-tool", 0), "p:2", MADE_AT);

    expect(invalidLedgerEntryErrorOf([fine, free])).toBeUndefined();
    expect(invalidLedgerEntryErrorOf([])).toBeUndefined();
    expect(() => {
      assertLedgerEntries([fine, free]);
    }).not.toThrow();
  });

  it("the first refused is named", () => {
    expect(invalidLedgerEntryErrorOf([null, { ...fine, ledgerId: "" }])).toMatchObject({
      index: 0,
      reason: "it is not an object",
    });
  });
});

describe("#817: a date that is no date is refused, as a cutoff or a mark", () => {
  it("names what it is and what it got", () => {
    expect(invalidDateErrorOf(MADE_AT, "the cutoff")).toBeUndefined();
    expect(invalidDateErrorOf(new Date(Number.NaN), "the cutoff")).toEqual(
      new TypeError("the cutoff is no valid Date: Invalid Date"),
    );
    expect(invalidDateErrorOf("2026-11-04", "the mark")).toEqual(
      new TypeError("the mark is no valid Date: 2026-11-04"),
    );
    expect(() => {
      assertValidDate(0, "the cutoff");
    }).toThrow("the cutoff is no valid Date: 0");
    expect(() => {
      assertValidDate(MADE_AT, "the cutoff");
    }).not.toThrow();
  });

  it("#869: assertLedgerCutoff refuses a cutoff that is no valid Date with the ledger's code", () => {
    for (const cutoff of [new Date(Number.NaN), "2026-11-04", 0, undefined])
      expect(() => {
        assertLedgerCutoff(cutoff);
      }).toThrow(
        expect.objectContaining({
          constructor: CostLedgerCutoffInvalidError,
          name: "CostLedgerCutoffInvalidError",
          code: "cost-ledger.cutoff-invalid",
          reason: `the cutoff is no valid Date: ${String(cutoff)}`,
          message: `the ledger was handed no valid Date as its prune's cutoff: the cutoff is no valid Date: ${String(cutoff)} — nothing was pruned and the pruning mark stays where it was; prune with a valid Date`,
        }),
      );
    expect(() => {
      assertLedgerCutoff(MADE_AT);
    }).not.toThrow();
  });

  it("expiredEntriesOf fails closed on a mark that is no date, and names nothing without a mark", () => {
    const never = () => true;

    expect(() => expiredEntriesOf([fine], new Date(Number.NaN), never)).toThrow(
      "the pruning mark is no valid Date: Invalid Date",
    );
    expect(expiredEntriesOf([fine], undefined, () => false)).toEqual([]);
  });

  it("expiredEntriesOf names each entry before the mark it does not hold, once", () => {
    const old = ledgerEntryOf(
      recordToolCost("pay-tool", 1),
      "p:3",
      new Date("2026-11-04T08:00:00.000Z"),
    );
    const held = ledgerEntryOf(
      recordToolCost("pay-tool", 1),
      "p:4",
      new Date("2026-11-04T08:00:00.000Z"),
    );
    const atMark = ledgerEntryOf(
      recordToolCost("pay-tool", 1),
      "p:5",
      new Date("2026-11-04T09:00:00.000Z"),
    );
    const mark = new Date("2026-11-04T09:00:00.000Z");

    expect(expiredEntriesOf([old, held, atMark, old], mark, (id) => id === "p:4")).toEqual(["p:3"]);
  });

  it("unrecordedEntriesOf keeps the entries isNew keeps, asked with their id and Date", () => {
    const asked: (readonly [string, Date])[] = [];
    const other = ledgerEntryOf(recordToolCost("pay-tool", 1), "p:6", MADE_AT);

    const kept = unrecordedEntriesOf([fine, other], (id, madeAt) => {
      asked.push([id, madeAt]);
      return id === "p:6";
    });

    expect(kept).toEqual([other]);
    expect(asked).toEqual([
      ["p:0", MADE_AT],
      ["p:6", MADE_AT],
    ]);
  });
});

describe("#817, #869: a store refuses a cutoff that is no date, naming it, with the ledger's code", () => {
  it.each([
    ["in memory", () => new InMemoryCostLedgerRepository()],
    ["SQLite", () => new SqliteCostLedgerRepository(connectionTo(temporarySqlitePath()))],
  ])("%s", async (_name, ledgerOf) => {
    const ledger = ledgerOf();

    await expect(ledger.deleteByMadeAtBefore(new Date(Number.NaN))).rejects.toThrow(
      new CostLedgerCutoffInvalidError({ reason: "the cutoff is no valid Date: Invalid Date" }),
    );
  });
});

describe("#906: the ledger's errors keep their cause", () => {
  it("each takes a cause and keeps it", () => {
    const cause = new Error("why");

    expect(new CostLedgerCutoffInvalidError({ reason: "r", cause }).cause).toBe(cause);
    expect(new CostLedgerEntryInvalidError({ index: 0, reason: "r", cause }).cause).toBe(cause);
    expect(
      new CostLedgerEntryExpiredError({ ledgerIds: ["l"], prunedBefore: new Date(0), cause }).cause,
    ).toBe(cause);
  });
});
