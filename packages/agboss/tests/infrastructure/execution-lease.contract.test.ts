/**
 * #265 AC11 (Q58), #481 AC3: `ExecutionLeaseRepository` — the published lease contract
 * (`executionLeaseContract`, `@agboss/core/testing/contracts`), run against the in-memory default
 * and `SqliteExecutionLeaseRepository` (two instances on one file). The pause transition is in
 * paused-execution.contract.test.ts.
 */
import { describe } from "vitest";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { executionLeaseContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

describe("#481 AC3: the core's lease stores pass the published lease contract", () => {
  executionLeaseContract(
    inMemoryTarget(
      ({ clock, application, database }) =>
        new InMemoryExecutionLeaseRepository(clock, application, database),
    ),
  );
  executionLeaseContract(
    sqliteTarget(
      ({ clock, application, connection }) =>
        new SqliteExecutionLeaseRepository(connection(), clock, application),
    ),
  );
});
