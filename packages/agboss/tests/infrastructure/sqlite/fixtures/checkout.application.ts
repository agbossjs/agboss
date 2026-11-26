import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { Checkout } from "../../../app/fixtures/run-context.workflow.js";
import { sqliteTestStorage } from "./sqlite-test-storage.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/** The checkout on SQLite: its checkpoints, pauses, records, leases and tree keys in one file. */
@Application({
  name: "sqlite-checkout-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  storage: sqliteTestStorage(),
  workflows: [Checkout],
  budgets: TEST_BUDGETS,
})
export class SqliteCheckoutApplication {}
