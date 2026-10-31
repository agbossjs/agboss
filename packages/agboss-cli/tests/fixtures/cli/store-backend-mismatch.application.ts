import { Application, SqliteFencedEffectRepository } from "../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { TestWorkflow } from "../../../../agboss/tests/fixtures/test-workflow/test.workflow.js";
import { SqliteTestEnvironment } from "../../../../agboss/tests/infrastructure/sqlite/fixtures/environments/app.environment.js";

/**
 * `agboss check` fixture (#526 M2, acceptance): `SqliteFencedEffectRepository` listed without
 * `SqliteExecutionLeaseRepository` — its leases are the in-memory default, another backend.
 */
@Application({
  name: "store-backend-mismatch-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [TestWorkflow],
  providers: [SqliteFencedEffectRepository],
  budgets: TEST_BUDGETS,
})
export class StoreBackendMismatchApplication {}

// the workflow agboss check types (.agboss/types.d.ts)
export { TestWorkflow };
