import {
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { SingleChildWorkflow } from "../../../channels/fixtures/child-pauses.workflow.js";
import {
  CustomerOrderConfirmationChannel,
  FinanceDeskRefundApprovalChannel,
  PauseLog,
} from "../../../channels/fixtures/pauses.workflow.js";
import { PlannedIdGenerator } from "../../fixtures/minted-ids.application.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/**
 * #663 — a root and its `ParentInstance` child whose refund waits for the finance desk, on every
 * SQLite store of the test's file and on the planned ids: what a file of before holds, and what a
 * new execution minted with an id of before finds there.
 */
@Application({
  name: "sqlite-planned-pauses-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [SingleChildWorkflow],
  providers: [
    PlannedIdGenerator,
    FinanceDeskRefundApprovalChannel,
    CustomerOrderConfirmationChannel,
    SqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
  ],
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class SqlitePlannedPausesApplication {}
