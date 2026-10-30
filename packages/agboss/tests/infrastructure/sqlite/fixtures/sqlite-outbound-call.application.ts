import {
  SqliteCheckpointSaver,
  SqliteConnection,
  SqliteCostLedgerRepository,
  SqliteExecutionLeaseEventRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteOutboundCallRepository,
  SqlitePausedExecutionRepository,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { RecoveryLog } from "../../fixtures/recovery.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import {
  ChargeWorkflow,
  EmailPiiPolicy,
  OutboundCallLog,
} from "../../../app/fixtures/outbound-call.workflow.js";

/**
 * #505 on SQLite — the charge of the in-memory tests on one SQLite file shared by a test's
 * instances: the intents in `outbound_calls`, beside the leases they check.
 */
@Application({
  name: "sqlite-outbound-call-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog, OutboundCallLog],
  budgets: TEST_BUDGETS,
  piiPolicies: [EmailPiiPolicy],
  providers: [
    SqliteExecutionLeaseRepository,
    SqliteOutboundCallRepository,
    SqliteExecutionLeaseEventRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteConnection,
  ],
})
export class SqliteOutboundCallApplication {}

/** The SQLite leases with the in-memory outbound-call store left unlisted: its first call fails. */
@Application({
  name: "unlisted-outbound-call-store-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [ChargeWorkflow],
  budgets: TEST_BUDGETS,
  piiPolicies: [EmailPiiPolicy],
  providers: [SqliteExecutionLeaseRepository, SqliteConnection],
})
export class UnlistedOutboundCallStoreApplication {}
