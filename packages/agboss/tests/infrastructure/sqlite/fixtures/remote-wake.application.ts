import {
  SqliteCheckpointSaver,
  SqliteChildExecutionQueueRepository,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../../helpers/log.js";
import { YieldLog, YieldOneWorkflow } from "../../../app/fixtures/remote-child-yield.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/** #917 — one `AnyInstance` child on two instances over one SQLite file, every store SQLite. */
@Application({
  name: "remote-wake-sqlite-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [YieldOneWorkflow],
  observers: [YieldLog],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 1,
  providers: [
    RecordingLogger,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqliteExecutionTreeRepository,
    SqlitePausedExecutionRepository,
    SqliteRateLimitRepository,
    SqliteChildExecutionQueueRepository,
  ],
})
export class RemoteWakeSqliteApplication {}
