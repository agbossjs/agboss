import type { DatabaseSync } from "node:sqlite";
import { WorkflowStartTextDto } from "../../../../src/dto/index.js";
import {
  Action,
  ExecutionContext,
  SqliteCheckpointSaver,
  SqliteConnection,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteFencedEffectRepository,
  SqlitePausedExecutionRepository,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  fencedEffectKeyOf,
  type Produced,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { start } from "../../../helpers/flow.js";
import { RecoveryLog } from "../../fixtures/recovery.workflow.js";
import {
  book,
  ChargeReceiptDto,
  DoubleChargeWorkflow,
  gate,
} from "../../../app/fixtures/fenced-effect.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";

/**
 * #500 — the order charged through `SqliteFencedEffectRepository`: the charge row goes into a table
 * of the application's own SQLite file in the effect's `BEGIN IMMEDIATE` transaction, synchronously
 * — no table of fencing or idempotency of its own. The levers of `fenced-effect.workflow.ts` freeze
 * a run before or after its effect.
 */

/** The application's business table, on the file its stores share. */
const ORDER_CHARGES = `CREATE TABLE IF NOT EXISTS order_charges (
  order_id TEXT NOT NULL, token INTEGER NOT NULL, charge_id TEXT NOT NULL)`;

/** One charge row in the effect's transaction; the receipt it gives. */
function insertCharge(database: DatabaseSync, order: string, token: number): { chargeId: string } {
  database.exec(ORDER_CHARGES);
  const chargeId = `charge-${order}-${String(token)}`;
  database
    .prepare("INSERT INTO order_charges (order_id, token, charge_id) VALUES (?, ?, ?)")
    .run(order, token, chargeId);
  return { chargeId };
}

/** The charge rows of the file, oldest first (read by the test, outside any effect). */
export function chargesIn(database: DatabaseSync): readonly string[] {
  database.exec(ORDER_CHARGES);
  return database
    .prepare("SELECT charge_id FROM order_charges ORDER BY rowid")
    .all()
    .map((row) => String(row.charge_id));
}

@Action({
  name: "sqlite-charge-order-action",
  description: "Charges the order once, through the SQLite fenced effect",
  input: { message: WorkflowStartTextDto },
  output: ChargeReceiptDto,
  deps: [ExecutionContext, SqliteFencedEffectRepository],
})
export class SqliteChargeOrderAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: SqliteFencedEffectRepository,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ChargeReceiptDto> {
    const key = fencedEffectKeyOf(this.executionContext, "charge");
    await gate("before");
    const order = input.message.value.text;
    const outcome = await this.fencedEffects
      .saveResultIfAbsent(key, (database) => insertCharge(database, order, key.token))
      .catch((error: unknown) => {
        book.runs.push({ token: key.token, status: "refused" });
        throw error;
      });
    book.runs.push({ token: key.token, status: outcome.status });
    await gate("after");
    return outcome.result;
  }
}

@WorkflowStart({
  name: "sqlite-charge-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class SqliteChargeWorkflowStart {}

@WorkflowFinish({
  name: "sqlite-charged-workflow-finish",
  description: "The receipt",
  output: ChargeReceiptDto,
})
export class SqliteChargedWorkflowFinish {}

@Workflow({
  name: "sqlite-charge-workflow",
  version: "1.0.0",
  flow: [
    start(SqliteChargeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(SqliteChargeOrderAction)
      .returns(ChargeReceiptDto)
      .toFinish(SqliteChargedWorkflowFinish),
  ],
})
export class SqliteChargeWorkflow {}

@Application({
  name: "sqlite-fenced-effect-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [SqliteChargeWorkflow],
  observers: [RecoveryLog],
  providers: [
    SqliteExecutionLeaseRepository,
    SqliteFencedEffectRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteConnection, // the file's one connection: a component injects the SQLite store
  ],
  budgets: TEST_BUDGETS,
})
export class SqliteFencedEffectApplication {}

/** The SQLite leases, no fenced-effect store listed: the in-memory default refuses at its first call. */
@Application({
  name: "unlisted-fenced-effect-store-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [DoubleChargeWorkflow],
  budgets: TEST_BUDGETS,
  providers: [SqliteExecutionLeaseRepository, SqliteConnection],
})
export class UnlistedFencedEffectStoreApplication {}
