import { Application } from "../../../../src/application/application.js";
import {
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "../../../../src/index.js";
import { SqliteCheckpointSaver } from "../../../../src/internal.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  CHANNELS,
  ExtensionPauseListener,
  FLOWS,
} from "../../../flow/fixtures/pause-extension.fixture.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/**
 * #1099 — the extension fixture's workflows on the SQLite file with the real lease store, for the
 * processes of the racing-extensions test (the vitest fixtures' hooks are not loaded there).
 */
@Application({
  name: "sqlite-extension-process-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: FLOWS,
  budgets: TEST_BUDGETS,
  providers: [
    SqliteExecutionLeaseRepository,
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
export class SqliteExtensionProcessApplication {}
