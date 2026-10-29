/**
 * #401 PR 1, #481 AC3: `ExecutionHistoryRepository` — the published execution history contract
 * (`executionHistoryContract`), run against the in-memory default (two instances over one
 * database) and `SqliteExecutionHistoryRepository` (two instances on one file).
 */
import { describe } from "vitest";
import { InMemoryExecutionHistoryRepository } from "../../src/infrastructure/execution-history.repository.js";
import { SqliteExecutionHistoryRepository } from "../../src/infrastructure/sqlite/sqlite-execution-history.repository.js";
import { executionHistoryContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

describe("#481 AC3: the core's histories pass the published execution history contract", () => {
  executionHistoryContract(
    inMemoryTarget(({ database }) => new InMemoryExecutionHistoryRepository(database)),
  );
  executionHistoryContract(
    sqliteTarget(({ connection }) => new SqliteExecutionHistoryRepository(connection())),
  );
});
