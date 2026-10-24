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
import { ChildEventLog } from "../../../flow/runtime/fixtures/children.workflow.js";
import {
  RemoteItemsWorkflow,
  RemoteOneWorkflow,
} from "../../../flow/runtime/fixtures/remote-children.workflow.js";
import {
  RemoteHoldItemsWorkflow,
  RemoteReviewItemsWorkflow,
} from "../../../flow/runtime/fixtures/remote-recovery.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/**
 * #333 PR 2, PR 4 — children on any instance over one SQLite file (`AGBOSS_SQLITE_TEST_PATH`, a new
 * file per test): every store a SQLite implementation, the queue too; one step at a time per
 * instance (`maxConcurrentSteps: 1`), so a launch of several children needs both instances.
 */
@Application({
  name: "remote-sqlite-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [
    RemoteItemsWorkflow,
    RemoteOneWorkflow,
    RemoteReviewItemsWorkflow,
    RemoteHoldItemsWorkflow,
  ],
  observers: [ChildEventLog],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 1,
  providers: [
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
export class RemoteSqliteApplication {}
