import {
  SqliteCheckpointSaver,
  SqliteConnection,
  SqliteCostLedgerRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteFencedEffectRepository,
  SqlitePausedExecutionRepository,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { SqliteChildExecutionQueueRepository } from "../../../../src/infrastructure/sqlite/sqlite-child-execution-queue.repository.js";
import { SqliteExecutionLeaseRepository } from "../../../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteOutboundCallRepository } from "../../../../src/infrastructure/sqlite/sqlite-outbound-call.repository.js";
import { withHoldPoints } from "../../../../src/testing/faults/held-stores.js";
import { RecoveryLog } from "../../fixtures/recovery.workflow.js";
import { SqliteChargeWorkflow } from "./sqlite-fenced-effect.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";

/** #928 — the SQLite charge workflow on held stores: a hold or an outage can keep a call for ever. */
@Application({
  name: "store-bound-sqlite-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [SqliteChargeWorkflow],
  observers: [RecoveryLog],
  providers: [
    withHoldPoints(SqliteExecutionLeaseRepository),
    withHoldPoints(SqliteFencedEffectRepository),
    withHoldPoints(SqliteOutboundCallRepository),
    withHoldPoints(SqliteChildExecutionQueueRepository),
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteConnection,
  ],
  budgets: TEST_BUDGETS,
})
export class StoreBoundSqliteApplication {}
