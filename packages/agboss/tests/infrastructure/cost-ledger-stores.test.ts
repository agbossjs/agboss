/**
 * #633: the cost ledger contract on the core's two ledgers alone — the in-memory one shared by two
 * instances and the SQLite one on two connections to one file —, as `storeConformance` runs it,
 * without the other stores' suites: the `money` mutation shard's view of the ledger.
 */
import { describe } from "vitest";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { SqliteCostLedgerRepository } from "../../src/infrastructure/sqlite/sqlite-cost-ledger.repository.js";
import { costLedgerContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sharedInMemory, sqliteTarget } from "./contracts/store-kinds.js";

describe("#633: the core's cost ledgers pass the cost ledger contract", () => {
  costLedgerContract(
    inMemoryTarget((seam) =>
      sharedInMemory(seam, "ledger", () => new InMemoryCostLedgerRepository()),
    ),
  );
  costLedgerContract(
    sqliteTarget(({ connection }) => new SqliteCostLedgerRepository(connection())),
  );
});
