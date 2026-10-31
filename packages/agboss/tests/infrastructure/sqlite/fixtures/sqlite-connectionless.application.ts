import { Application } from "../../../../src/application/application.js";
import {
  SqliteExecutionLeaseEventRepository,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
} from "../../../../src/index.js";
import { ChargeWorkflow, EmailPiiPolicy } from "../../../app/fixtures/outbound-call.workflow.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import { SqliteChargeWorkflow } from "./sqlite-fenced-effect.workflow.js";

/**
 * #526 AC8 — SQLite applications that do not list `SqliteConnection`: the store `OutboundCalls`
 * uses, and a component that injects the fenced-effect store's own class, reach it anyway.
 */

/** The SQLite stores of the charge, without `SqliteConnection`. */
@Application({
  name: "connectionless-outbound-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [ChargeWorkflow],
  budgets: TEST_BUDGETS,
  piiPolicies: [EmailPiiPolicy],
  providers: [
    SqliteExecutionLeaseRepository,
    SqliteOutboundCallRepository,
    SqliteExecutionLeaseEventRepository,
  ],
})
export class ConnectionlessOutboundApplication {}

/** An action that injects the SQLite fenced-effect store's own class, the connection unlisted. */
@Application({
  name: "connectionless-effect-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [SqliteChargeWorkflow],
  budgets: TEST_BUDGETS,
  providers: [SqliteExecutionLeaseRepository, SqliteFencedEffectRepository],
})
export class ConnectionlessEffectApplication {}
