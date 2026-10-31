import type { DatabaseSync } from "node:sqlite";
import { randomIdGenerator } from "../../../src/infrastructure/clock.js";
import { InMemoryCheckpointSaver } from "../../../src/infrastructure/contracts.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { InMemoryExecutionHistoryRepository } from "../../../src/infrastructure/execution-history.repository.js";
import { InMemoryExecutionLeaseEventRepository } from "../../../src/infrastructure/execution-lease-event.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { InMemoryExecutionRecordRepository } from "../../../src/infrastructure/execution-record.repository.js";
import type { InMemoryFencedEffectTransaction } from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import { InMemoryMeshRequestRepository } from "../../../src/infrastructure/mesh-request.repository.js";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/paused-execution.repository.js";
import { InMemoryRateLimitRepository } from "../../../src/infrastructure/rate-limit.repository.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { SqliteChildExecutionQueueRepository } from "../../../src/infrastructure/sqlite/sqlite-child-execution-queue.repository.js";
import { SqliteCostLedgerRepository } from "../../../src/infrastructure/sqlite/sqlite-cost-ledger.repository.js";
import { SqliteExecutionHistoryRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-history.repository.js";
import {
  SqliteExecutionLeaseEventRepository,
  SqliteExecutionLeaseRepository,
} from "../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteExecutionRecordRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import { SqliteExecutionTreeRepository } from "../../../src/infrastructure/sqlite/sqlite-execution-tree.repository.js";
import { SqliteMeshRequestRepository } from "../../../src/infrastructure/sqlite/sqlite-mesh-request.repository.js";
import { SqlitePausedExecutionRepository } from "../../../src/infrastructure/sqlite/sqlite-paused-execution.repository.js";
import { SqliteRateLimitRepository } from "../../../src/infrastructure/sqlite/sqlite-rate-limit.repository.js";
import type { ConformanceStores } from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects, sqliteFencedEffects } from "./fenced-effect-stores.js";
import { inMemoryOutboundCalls, sqliteOutboundCalls } from "./outbound-call-stores.js";
import { inMemoryTarget, sharedInMemory, sqliteTarget } from "./store-kinds.js";

/**
 * The core's two store sets for `storeConformance` (#526 AC2): every built-in in-memory store (two
 * instances over one `InMemoryDatabase`) and every SQLite store (two connections to one temporary
 * file) — each entry a target of its kind, so a test gets a new database or file.
 */

/** Every in-memory store of the core. */
export const inMemoryStores = (): ConformanceStores<InMemoryFencedEffectTransaction> => ({
  checkpointSaver: inMemoryTarget((seam) =>
    sharedInMemory(seam, "checkpoints", () => new InMemoryCheckpointSaver()),
  ),
  childExecutionQueue: inMemoryTarget(
    ({ clock, application, database }) =>
      new InMemoryChildExecutionQueueRepository(clock, application, database),
  ),
  costLedger: inMemoryTarget((seam) =>
    sharedInMemory(seam, "ledger", () => new InMemoryCostLedgerRepository()),
  ),
  executionHistory: inMemoryTarget(
    ({ database }) => new InMemoryExecutionHistoryRepository(database),
  ),
  executionLease: inMemoryTarget(
    ({ storeClock, application, database }) =>
      new InMemoryExecutionLeaseRepository(storeClock, application, database),
  ),
  executionLeaseEvent: inMemoryTarget(
    ({ database }) => new InMemoryExecutionLeaseEventRepository(database),
  ),
  executionRecord: inMemoryTarget((seam) =>
    sharedInMemory(
      seam,
      "records",
      () => new InMemoryExecutionRecordRepository(seam.clock, randomIdGenerator),
    ),
  ),
  executionTree: inMemoryTarget(({ database }) => new InMemoryExecutionTreeRepository(database)),
  fencedEffect: inMemoryTarget(inMemoryFencedEffects(false)),
  meshRequest: inMemoryTarget(({ database }) => new InMemoryMeshRequestRepository(database)),
  outboundCall: inMemoryTarget(inMemoryOutboundCalls),
  pausedExecution: inMemoryTarget((seam) =>
    sharedInMemory(seam, "paused", () => new InMemoryPausedExecutionRepository()),
  ),
  rateLimit: inMemoryTarget(
    ({ clock, application, database }) =>
      new InMemoryRateLimitRepository(clock, application, database),
  ),
});

/** Every SQLite store of the core. */
export const sqliteStores = (): ConformanceStores<DatabaseSync> => ({
  checkpointSaver: sqliteTarget(({ connection }) => new SqliteCheckpointSaver(connection())),
  childExecutionQueue: sqliteTarget(
    ({ clock, application, connection }) =>
      new SqliteChildExecutionQueueRepository(connection(), clock, application),
  ),
  costLedger: sqliteTarget(({ connection }) => new SqliteCostLedgerRepository(connection())),
  executionHistory: sqliteTarget(
    ({ connection }) => new SqliteExecutionHistoryRepository(connection()),
  ),
  executionLease: sqliteTarget(
    ({ storeClock, application, connection }) =>
      new SqliteExecutionLeaseRepository(connection(), storeClock, application),
  ),
  executionLeaseEvent: sqliteTarget(
    ({ connection }) => new SqliteExecutionLeaseEventRepository(connection()),
  ),
  executionRecord: sqliteTarget(
    ({ clock, connection, application }) =>
      new SqliteExecutionRecordRepository(connection(), clock, application, randomIdGenerator),
  ),
  executionTree: sqliteTarget(({ connection }) => new SqliteExecutionTreeRepository(connection())),
  fencedEffect: sqliteTarget(sqliteFencedEffects),
  meshRequest: sqliteTarget(({ connection }) => new SqliteMeshRequestRepository(connection())),
  outboundCall: sqliteTarget(sqliteOutboundCalls),
  pausedExecution: sqliteTarget(
    ({ clock, connection }) => new SqlitePausedExecutionRepository(connection(), clock),
  ),
  rateLimit: sqliteTarget(
    ({ clock, application, connection }) =>
      new SqliteRateLimitRepository(connection(), clock, application),
  ),
});
