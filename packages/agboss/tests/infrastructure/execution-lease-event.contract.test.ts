/**
 * #501: `ExecutionLeaseEventRepository` — the published lease event contract
 * (`executionLeaseEventContract`), run against the in-memory default (two instances over one
 * database) and `SqliteExecutionLeaseEventRepository` (two instances on one file).
 */
import { describe } from "vitest";
import { InMemoryExecutionLeaseEventRepository } from "../../src/infrastructure/execution-lease-event.repository.js";
import { SqliteExecutionLeaseEventRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { executionLeaseEventContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

describe("#501: the core's lease event stores pass the published lease event contract", () => {
  executionLeaseEventContract(
    inMemoryTarget(({ database }) => new InMemoryExecutionLeaseEventRepository(database)),
  );
  executionLeaseEventContract(
    sqliteTarget(({ connection }) => new SqliteExecutionLeaseEventRepository(connection())),
  );
});
