import {
  SqliteCheckpointSaver,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { Checkout } from "../../../app/fixtures/run-context.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/** The checkout on SQLite: its checkpoints, pauses, records, leases and tree keys in one file. */
@Application({
  name: "sqlite-checkout-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [Checkout],
  budgets: TEST_BUDGETS,
  providers: [
    SqliteCheckpointSaver,
    SqlitePausedExecutionRepository,
    SqliteExecutionRecordRepository,
    SqliteExecutionLeaseRepository,
    SqliteExecutionTreeRepository,
  ],
})
export class SqliteCheckoutApplication {}
