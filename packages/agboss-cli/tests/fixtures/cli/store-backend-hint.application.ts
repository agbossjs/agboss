import { Application } from "../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { TestWorkflow } from "../../../../agboss/tests/fixtures/test-workflow/test.workflow.js";
import { PostgresEffects } from "../../../../agboss/tests/application/fixtures/store-backends.fixture.js";
import { SqliteTestEnvironment } from "../../../../agboss/tests/infrastructure/sqlite/fixtures/environments/app.environment.js";

/**
 * `agboss check` fixture (#539 M1, acceptance): a fenced-effect store on backend "postgres" listed
 * without a lease store — the application's leases are the in-memory default.
 */
@Application({
  name: "store-backend-hint-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [TestWorkflow],
  providers: [PostgresEffects],
  budgets: TEST_BUDGETS,
})
export class StoreBackendHintApplication {}

// the workflow agboss check types (.agboss/types.d.ts)
export { TestWorkflow };
