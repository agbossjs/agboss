import type { RunnableConfig } from "@langchain/core/runnables";
import {
  Injectable,
  SqliteCheckpointSaver,
  SqliteConnection,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { RecoveryLog } from "../../fixtures/recovery.workflow.js";
import {
  isHungPut,
  never,
  pausesWindowWorkflows,
  WindowChannel,
  WindowSecondChannel,
  wroteWrites,
} from "../../../app/fixtures/writes-window-pauses.application.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/** #1098 — the trees of `writes-window-pauses.application.ts` on SQLite, its saver's log and cut. */

@Injectable({ deps: [SqliteConnection] })
export class PausesWindowSqliteCheckpoints extends SqliteCheckpointSaver {
  override put(...args: Parameters<SqliteCheckpointSaver["put"]>): Promise<RunnableConfig> {
    if (isHungPut(args[0], args[2].step)) return never<RunnableConfig>();
    return super.put(...args);
  }

  override async putWrites(...args: Parameters<SqliteCheckpointSaver["putWrites"]>): Promise<void> {
    await super.putWrites(...args);
    wroteWrites(args[0], args[1]);
  }
}

@Application({
  name: "pauses-window-sqlite-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: pausesWindowWorkflows,
  observers: [RecoveryLog],
  providers: [
    SqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    PausesWindowSqliteCheckpoints,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteConnection,
    WindowChannel,
    WindowSecondChannel,
  ],
  budgets: TEST_BUDGETS,
})
export class PausesWindowSqliteApplication {}
