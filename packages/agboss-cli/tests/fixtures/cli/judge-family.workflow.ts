// `agboss check --strict` fixture (#396 PR 5): an agent's judge of the agent's own model family —
// a warning, an error under --strict ([judge.same-model-family])
import { Application, EmptyEnvironment } from "../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { JudgeFamilyWorkflow } from "../../../../agboss/tests/judges/fixtures/judge-family.workflow.js";
import { TestModelProvider } from "../../../../agboss/src/testing/test-model-provider.js";

export { JudgeFamilyWorkflow };

/** The application `agboss --application` loads (#268): this workflow alone. */
@Application({
  modelProvider: TestModelProvider,
  name: "judge-family-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [JudgeFamilyWorkflow],
  budgets: TEST_BUDGETS,
})
export class JudgeFamilyApplication {}
