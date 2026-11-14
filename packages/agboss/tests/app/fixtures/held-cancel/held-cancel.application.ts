import { Application } from "../../../../src/application/application.js";
import { sqliteFaultStoreClasses } from "../../../faults/sqlite.fault-stores.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  DirectorChannel,
  ManagerChannel,
  PlainWorkflow,
  ShortExpiryWorkflow,
} from "../../../flow/fixtures/expiry.fixture.js";
import { HeldCancelEnvironment } from "./environments/app.environment.js";

/**
 * #1093: a workflow that rests on a question, every store on one SQLite file two processes open —
 * the process that holds the tree's lease, and a script that only calls `app.cancel`.
 */
@Application({
  name: "held-cancel-application",
  version: "1.0.0",
  environment: HeldCancelEnvironment,
  workflows: [PlainWorkflow, ShortExpiryWorkflow],
  budgets: TEST_BUDGETS,
  providers: [...sqliteFaultStoreClasses, DirectorChannel, ManagerChannel],
})
export class HeldCancelApplication {}
