import { Application } from "../../../../src/application/application.js";
import {
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "../../../../src/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  CHANNELS,
  ExtensionPauseListener,
  FLOWS,
} from "../../../flow/fixtures/pause-extension.fixture.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import { MortalSqliteExecutionLeaseRepository } from "./sqlite.workflow.js";

/**
 * #942 — the extension fixture's workflows (a manager's question with a 24 h deadline and a
 * reminder 2 h before it, …) in an application on the SQLite file: instances of it share the pauses.
 */
@Application({
  name: "sqlite-extension-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: FLOWS,
  budgets: TEST_BUDGETS,
  providers: [
    MortalSqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
    ...CHANNELS,
    ExtensionPauseListener,
  ],
})
export class SqliteExtensionApplication {}
