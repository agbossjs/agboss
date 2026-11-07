import {
  SqliteCheckpointSaver,
  SqliteChildExecutionQueueRepository,
  SqliteConnection,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "../../../../src/index.js";
import { Injectable } from "../../../../src/components/decorators.js";
import { Application } from "../../../../src/application/application.js";
import type {
  CostCounter,
  LedgerEntry,
} from "../../../../src/infrastructure/cost-ledger.repository.js";
import type { UsageRecord } from "../../../../src/finops/usage.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  AnyPayItemsWorkflow,
  holdsParentPay,
  ParentPayWorkflow,
} from "../../../budgets/fixtures/spend-in-flight.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/** The file's ledger, holding the write of the parent's own spend (#732) until the test lets it go. */
@Injectable({ deps: [SqliteConnection] })
export class HeldParentSqliteLedger extends SqliteCostLedgerRepository {
  override async saveAll(
    counters: readonly CostCounter[],
    records: readonly LedgerEntry[],
  ): Promise<void> {
    await holdsParentPay(records);
    return super.saveAll(counters, records);
  }
}

/**
 * #727, #732 — a tree's spend in flight on two instances over one SQLite file (each its own
 * connection: only the file carries the spend), every store a SQLite one, one step at a time on
 * each instance.
 */
@Application({
  name: "sqlite-spend-in-flight-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [AnyPayItemsWorkflow, ParentPayWorkflow],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 1,
  providers: [
    SqliteCheckpointSaver,
    HeldParentSqliteLedger,
    SqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqliteExecutionTreeRepository,
    SqlitePausedExecutionRepository,
    SqliteRateLimitRepository,
    SqliteChildExecutionQueueRepository,
  ],
})
export class SqliteSpendInFlightApplication {}
