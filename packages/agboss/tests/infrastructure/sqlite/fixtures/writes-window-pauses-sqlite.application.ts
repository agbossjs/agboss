import type { RunnableConfig } from "@langchain/core/runnables";
import {
  Injectable,
  SqliteCostLedgerRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
} from "../../../../src/index.js";
import { SqliteCheckpointSaver } from "../../../../src/internal.js";
import { SqliteConnection } from "../../../../src/infrastructure/sqlite/sqlite-connection.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { RecoveryLog } from "../../fixtures/recovery.workflow.js";
import {
  isHungPut,
  never,
  recordWrite,
  pausesWindowWorkflows,
  WindowChannel,
  WindowSecondChannel,
  wroteWrites,
} from "../../../app/fixtures/writes-window-pauses.application.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import { MortalSqliteExecutionLeaseRepository } from "./sqlite.workflow.js";
import { ApplicationContext } from "../../../../src/flow/context/application-context.js";
import { Clock, IdGenerator } from "../../../../src/infrastructure/clock.js";
import type { ExecutionRecordStatus } from "../../../../src/infrastructure/execution-record.repository.js";
import type { TurnOutcome } from "../../../../src/turns/index.js";

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

/** The records on the file, each write logged and open to the test's hook (#1187). */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext, IdGenerator] })
export class PausesWindowSqliteRecords extends SqliteExecutionRecordRepository {
  readonly #instanceId: string;

  constructor(
    connection: SqliteConnection,
    clock: Clock,
    applicationContext: ApplicationContext,
    idGenerator: IdGenerator,
  ) {
    super(connection, clock, applicationContext, idGenerator);
    this.#instanceId = applicationContext.instanceId;
  }

  override async complete(turnId: string, outcome: TurnOutcome): Promise<void> {
    const write = { op: "complete" as const, status: outcome.status, instanceId: this.#instanceId };
    await recordWrite(write, async () => {
      await super.complete(turnId, outcome);
      return true;
    });
  }

  override completeIfStatus(
    turnId: string,
    expected: ExecutionRecordStatus,
    outcome: TurnOutcome,
  ): Promise<boolean> {
    const write = { op: "mark" as const, status: outcome.status, instanceId: this.#instanceId };
    return recordWrite(write, () => super.completeIfStatus(turnId, expected, outcome));
  }
}

@Application({
  name: "pauses-window-sqlite-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: pausesWindowWorkflows,
  observers: [RecoveryLog],
  providers: [
    MortalSqliteExecutionLeaseRepository,
    PausesWindowSqliteRecords,
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
