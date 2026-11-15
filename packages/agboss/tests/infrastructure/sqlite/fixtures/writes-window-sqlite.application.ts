import type { RunnableConfig } from "@langchain/core/runnables";
import type { CheckpointTuple } from "@langchain/langgraph";
import {
  Injectable,
  SqliteCheckpointSaver,
  SqliteConnection,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteFencedEffectRepository,
  SqlitePausedExecutionRepository,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { withHoldPoints } from "../../../../src/testing/faults/held-stores.js";
import { RecordingLogger } from "../../../helpers/log.js";
import { RecoveryLog } from "../../fixtures/recovery.workflow.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  isHungGet,
  isHungPut,
  isHungWrite,
  never,
  threadOf,
  wroteOne,
} from "../../../app/fixtures/writes-window.application.js";
import { SqliteChargeWorkflow } from "./sqlite-fenced-effect.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/** #1090 — the SQLite charge workflow on the levers of `writes-window.application.ts`. */

@Injectable({ deps: [SqliteConnection] })
export class WindowSqliteCheckpoints extends SqliteCheckpointSaver {
  override put(...args: Parameters<SqliteCheckpointSaver["put"]>): Promise<RunnableConfig> {
    if (isHungPut(threadOf(args[0]))) return never<RunnableConfig>();
    return super.put(...args);
  }

  override getTuple(
    ...args: Parameters<SqliteCheckpointSaver["getTuple"]>
  ): Promise<CheckpointTuple | undefined> {
    return isHungGet() ? never<CheckpointTuple | undefined>() : super.getTuple(...args);
  }

  override async putWrites(...args: Parameters<SqliteCheckpointSaver["putWrites"]>): Promise<void> {
    if (isHungWrite(threadOf(args[0]))) return never<undefined>();
    await super.putWrites(...args);
    wroteOne();
  }
}

const HeldSqliteLeases = withHoldPoints(SqliteExecutionLeaseRepository);

@Application({
  name: "writes-window-sqlite-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [SqliteChargeWorkflow],
  observers: [RecoveryLog],
  providers: [
    HeldSqliteLeases,
    SqliteFencedEffectRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    WindowSqliteCheckpoints,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteConnection,
    RecordingLogger,
  ],
  budgets: TEST_BUDGETS,
})
export class WritesWindowSqliteApplication {}
