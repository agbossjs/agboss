/**
 * #265 AC7 / AC8: `CostLedgerRepository` — one counter per key and UTC day (the framework clock's
 * day), each model call's cost added to it; with several instances the counters are shared through
 * the listed implementation. One suite, run against the in-memory default and
 * `SqliteCostLedgerRepository` (two instances on one file).
 */
import { describe, expect, it } from "vitest";
import type { UsageRecord } from "../../src/finops/usage.js";
import type { CostLedgerRepository } from "../../src/index.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { SqliteCostLedgerRepository } from "../../src/infrastructure/sqlite/sqlite-cost-ledger.repository.js";
import { sharedInMemory, storeKinds } from "./contracts/store-kinds.js";

const kinds = storeKinds<CostLedgerRepository>({
  inMemory: (seam) =>
    sharedInMemory(seam, "ledger", () => new InMemoryCostLedgerRepository(seam.clock.now)),
  sqlite: ({ clock, connection }) => new SqliteCostLedgerRepository(connection(), clock.now),
});

/** A model call that cost `costUsd` (only the cost is counted). */
const call = (costUsd: number): UsageRecord =>
  ({ caller: "clerk-agent", model: "test/clerk", costUsd }) as UsageRecord;

describe.each(kinds)("#265 AC8: the cost ledger ($name)", ({ twoInstances }) => {
  it("each call's cost is added to its key's day, shared by the instances", async () => {
    const { first, second } = twoInstances();

    await first.saveAll("desk-workflow", [call(0.25), call(0.5)]);
    await second.saveAll("desk-workflow", [call(0.25)]);

    expect(await first.findSpentToday("desk-workflow")).toBe(1);
    expect(await second.findSpentToday("desk-workflow")).toBe(1);
    expect(await second.findSpentToday("other-workflow")).toBe(0);
  });

  it("the counter resets at 00:00 UTC (the framework's clock)", async () => {
    const { clock, first, second } = twoInstances();
    await first.saveAll("desk-workflow", [call(0.75)]);

    await clock.advance("1d");

    expect(await second.findSpentToday("desk-workflow")).toBe(0);
  });

  it("concurrent saves of two instances lose nothing", async () => {
    const { first, second } = twoInstances();

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? first : second).saveAll("desk-workflow", [call(0.125)]),
      ),
    );

    expect(await first.findSpentToday("desk-workflow")).toBe(1.25);
  });
});
