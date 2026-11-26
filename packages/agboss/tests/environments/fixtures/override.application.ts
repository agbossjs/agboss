import { Application } from "../../../src/application/application.js";
import { DatabaseStorage, SqliteDriver } from "../../../src/index.js";
import { hours } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { BookOrderWorkflow } from "../../app/fixtures/rotation/rotation.application.js";
import { overrideEnv } from "./override-env.js";

/** The storage reads its file and its idempotency secret from `overrideEnv`'s references. */
@DatabaseStorage({
  name: "override-storage",
  driver: SqliteDriver({ path: overrideEnv.databasePath }),
  auditLogTtl: hours(24),
  ledgerEntriesTtl: hours(24),
  idempotencySecret: overrideEnv.idempotency,
})
class OverrideStorage {}

@Application({
  name: "override-application",
  version: "1.0.0",
  workflows: [BookOrderWorkflow],
  storage: OverrideStorage,
  budgets: TEST_BUDGETS,
})
export class OverrideApplication {}
