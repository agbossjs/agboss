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
import { PlannedIdGenerator } from "../../fixtures/minted-ids.application.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import { NoteWorkflow } from "./sqlite.workflow.js";

/** #578 — One agent on every SQLite store of the test's file, on the planned ids. */
@Application({
  name: "sqlite-planned-ids-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [NoteWorkflow],
  providers: [
    PlannedIdGenerator,
    SqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
  ],
  budgets: TEST_BUDGETS,
})
export class SqlitePlannedIdsApplication {}
