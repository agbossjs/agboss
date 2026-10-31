import {
  Application,
  InMemoryFencedEffectRepository,
  SqliteFencedEffectRepository,
} from "../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { TestWorkflow } from "../../../../agboss/tests/fixtures/test-workflow/test.workflow.js";
import { SqliteTestEnvironment } from "../../../../agboss/tests/infrastructure/sqlite/fixtures/environments/app.environment.js";

/**
 * `agboss check` fixture (#539 M2, acceptance): two fenced-effect stores listed together, beside
 * the in-memory default leases — the SQLite one also of another backend than the leases.
 */
@Application({
  name: "two-effect-stores-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [TestWorkflow],
  providers: [SqliteFencedEffectRepository, InMemoryFencedEffectRepository],
  budgets: TEST_BUDGETS,
})
export class TwoEffectStoresApplication {}

// the workflow agboss check types (.agboss/types.d.ts)
export { TestWorkflow };
