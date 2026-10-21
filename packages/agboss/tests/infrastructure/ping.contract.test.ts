/**
 * #300: every store contract's `ping()` — the in-memory defaults resolve, the SQLite ones run one
 * `SELECT 1` on their connection and reject once it is closed (what `app.checkReadiness()` reports
 * as that store's `Unhealthy`). The checkpoint savers of the framework have one too.
 */
import { describe, expect, it } from "vitest";
import { randomIdGenerator } from "../../src/infrastructure/clock.js";
import { InMemoryCheckpointSaver } from "../../src/infrastructure/contracts.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { InMemoryExecutionTreeRepository } from "../../src/infrastructure/execution-tree.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { InMemoryRateLimitRepository } from "../../src/infrastructure/rate-limit.repository.js";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import type { SqliteConnection } from "../../src/infrastructure/sqlite/sqlite-connection.js";
import { SqliteCostLedgerRepository } from "../../src/infrastructure/sqlite/sqlite-cost-ledger.repository.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteExecutionRecordRepository } from "../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import { SqliteExecutionTreeRepository } from "../../src/infrastructure/sqlite/sqlite-execution-tree.repository.js";
import { SqlitePausedExecutionRepository } from "../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { SqliteRateLimitRepository } from "../../src/infrastructure/sqlite/sqlite-rate-limit.repository.js";
import { connectionTo, storeKinds, temporarySqlitePath } from "./contracts/store-kinds.js";

/** A store as readiness sees it: something that answers `ping()`. */
interface PingedStore {
  ping(): Promise<void>;
}

/** Every store of an instance, one kind: the #265 contracts and the checkpoint saver. */
type Stores = Readonly<Record<string, PingedStore>>;

const kinds = storeKinds<Stores>({
  inMemory: ({ clock, application, database }) => ({
    records: new InMemoryExecutionRecordRepository(clock, randomIdGenerator),
    costLedger: new InMemoryCostLedgerRepository(),
    pausedExecutions: new InMemoryPausedExecutionRepository(),
    executionLeases: new InMemoryExecutionLeaseRepository(clock, application, database),
    executionTrees: new InMemoryExecutionTreeRepository(database),
    rateLimits: new InMemoryRateLimitRepository(clock, application, database),
    checkpointer: new InMemoryCheckpointSaver(),
  }),
  sqlite: ({ clock, application, connection }) => ({
    records: new SqliteExecutionRecordRepository(
      connection(),
      clock,
      application,
      randomIdGenerator,
    ),
    costLedger: new SqliteCostLedgerRepository(connection()),
    pausedExecutions: new SqlitePausedExecutionRepository(connection(), clock),
    executionLeases: new SqliteExecutionLeaseRepository(connection(), clock, application),
    executionTrees: new SqliteExecutionTreeRepository(connection()),
    rateLimits: new SqliteRateLimitRepository(connection(), clock, application),
    checkpointer: new SqliteCheckpointSaver(connection()),
  }),
});

describe.each(kinds)("#300: every store answers ping() ($name)", ({ twoInstances }) => {
  it("resolves on both instances, for every store", async () => {
    const { first, second } = twoInstances();
    const stores = [...Object.values(first), ...Object.values(second)];

    await expect(Promise.all(stores.map((store) => store.ping()))).resolves.toHaveLength(14);
  });
});

/** SQLite stores on one connection (closed by the test). */
function sqliteStoresOn(connection: SqliteConnection): readonly PingedStore[] {
  return [
    new SqliteCostLedgerRepository(connection),
    new SqliteExecutionTreeRepository(connection),
    new SqliteCheckpointSaver(connection),
  ];
}

describe("#300: a SQLite store whose connection is closed", () => {
  it("rejects its ping() with why", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const stores = sqliteStoresOn(connection);
    connection.onDestroy();

    const pinged = await Promise.allSettled(stores.map((store) => store.ping()));

    expect(pinged.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
  });
});
