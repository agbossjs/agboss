import {
  ApplicationContext,
  Clock,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  SqliteOutboundCallRepository,
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
 * #533 AC4 — the charge of `outbound-call.workflow.ts` on two instances whose clocks disagree, its
 * lease and its intents on one SQLite file (each instance its own connection), the rest in memory,
 * shared. `SkewChargeApplication`: the stores decide by their own time (`StoreClock`, #533).
 * `CallerClockChargeApplication`: the same stores deciding by the calling instance's `Clock` — what
 * the PostgreSQL store did before #533, so a test proves the scenario bites.
 */

/** The lease store on the caller's clock (before #533). */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })
export class CallerClockLeaseRepository extends SqliteExecutionLeaseRepository {}

/** The intents' store on the caller's clock (before #533): its `leaseStateOf` reads it too. */
@Injectable({ deps: [SqliteConnection, Clock] })
export class CallerClockOutboundCallRepository extends SqliteOutboundCallRepository {}

const charge = {
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog, OutboundCallLog],
  budgets: TEST_BUDGETS,
  piiPolicies: [EmailPiiPolicy],
} as const;

@Application({
  ...charge,
  name: "skew-charge-application",
  providers: [SqliteExecutionLeaseRepository, SqliteOutboundCallRepository],
})
export class SkewChargeApplication {}

@Application({
  ...charge,
  name: "caller-clock-charge-application",
  providers: [CallerClockLeaseRepository, CallerClockOutboundCallRepository],
})
export class CallerClockChargeApplication {}
