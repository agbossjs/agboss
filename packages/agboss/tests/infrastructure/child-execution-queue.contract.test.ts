/**
 * #333 PR 2, #481 AC3: `ChildExecutionQueueRepository` — the published queue contract
 * (`childExecutionQueueContract`), run against the in-memory default (two instances over one
 * database) and `SqliteChildExecutionQueueRepository` (two on one file).
 */
import { describe } from "vitest";
import { InMemoryChildExecutionQueueRepository } from "../../src/infrastructure/child-execution-queue.repository.js";
import { SqliteChildExecutionQueueRepository } from "../../src/infrastructure/sqlite/sqlite-child-execution-queue.repository.js";
import { childExecutionQueueContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

describe("#481 AC3: the core's queues pass the published child execution queue contract", () => {
  childExecutionQueueContract(
    inMemoryTarget(
      ({ clock, application, database }) =>
        new InMemoryChildExecutionQueueRepository(clock, application, database),
    ),
  );
  childExecutionQueueContract(
    sqliteTarget(
      ({ clock, application, connection }) =>
        new SqliteChildExecutionQueueRepository(connection(), clock, application),
    ),
  );
});
