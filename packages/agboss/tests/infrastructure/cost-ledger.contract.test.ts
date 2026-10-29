/**
 * #265 AC7 / AC8, #261 PR 5, #481 AC3: `CostLedgerRepository` — the published cost ledger
 * contract (`costLedgerContract`), run against the in-memory default (one ledger shared by both
 * instances) and `SqliteCostLedgerRepository` (two instances on one file).
 */
import { describe } from "vitest";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { SqliteCostLedgerRepository } from "../../src/infrastructure/sqlite/sqlite-cost-ledger.repository.js";
import { costLedgerContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sharedInMemory, sqliteTarget } from "./contracts/store-kinds.js";

describe("#481 AC3: the core's ledgers pass the published cost ledger contract", () => {
  costLedgerContract(
    inMemoryTarget((seam) =>
      sharedInMemory(seam, "ledger", () => new InMemoryCostLedgerRepository()),
    ),
  );
  costLedgerContract(
    sqliteTarget(({ connection }) => new SqliteCostLedgerRepository(connection())),
  );
});
