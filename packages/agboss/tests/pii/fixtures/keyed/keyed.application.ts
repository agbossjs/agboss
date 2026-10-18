/** The keyed application (#120): its PII key is a `Secret` field of its environment. */
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { KeyedWorkflow } from "../../keyed.fixture.js";
import { PiiEnvironment } from "./environments/app.environment.js";

@Application({
  name: "keyed-application",
  version: "1.0.0",
  environment: PiiEnvironment,
  pseudonymKey: "piiPseudonymKey",
  workflows: [KeyedWorkflow],
  budgets: TEST_BUDGETS,
})
export class KeyedApplication {}
