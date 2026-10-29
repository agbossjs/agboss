/**
 * #265 AC7, #481 AC3: `ExecutionRecordRepository` — the published execution record contract
 * (`executionRecordContract`), run against the in-memory default (one store shared by both
 * instances) and `SqliteExecutionRecordRepository` (two instances on one file).
 */
import { describe } from "vitest";
import { randomIdGenerator } from "../../src/infrastructure/clock.js";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { SqliteExecutionRecordRepository } from "../../src/infrastructure/sqlite/sqlite-execution-record.repository.js";
import { executionRecordContract } from "../../src/testing/contracts/index.js";
import { inMemoryTarget, sharedInMemory, sqliteTarget } from "./contracts/store-kinds.js";

describe("#481 AC3: the core's record stores pass the published execution record contract", () => {
  executionRecordContract(
    inMemoryTarget((seam) =>
      sharedInMemory(
        seam,
        "records",
        () => new InMemoryExecutionRecordRepository(seam.clock, randomIdGenerator),
      ),
    ),
  );
  executionRecordContract(
    sqliteTarget(
      ({ clock, connection, application }) =>
        new SqliteExecutionRecordRepository(connection(), clock, application, randomIdGenerator),
    ),
  );
});
