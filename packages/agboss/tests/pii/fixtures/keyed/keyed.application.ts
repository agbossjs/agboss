/** The keyed application (#120): its PII key is a `Secret` field of its environment. */
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { KeyedExecutionContext, KeyedWorkflow } from "../../keyed.fixture.js";
import { PiiEnvironment } from "./environments/app.environment.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

@Application({
  name: "keyed-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: PiiEnvironment,
  piiKeyField: "piiPseudonymKey",
  workflows: [KeyedWorkflow],
  executionContext: KeyedExecutionContext,
  budgets: TEST_BUDGETS,
})
export class KeyedApplication {}
