import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { PlannedIdGenerator } from "../../fixtures/minted-ids.application.js";
import { sqliteTestStorage } from "./sqlite-test-storage.js";
import { NoteWorkflow } from "./sqlite.workflow.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/** #578 — One agent on every SQLite store of the test's file, on the planned ids. */
@Application({
  name: "sqlite-planned-ids-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  storage: sqliteTestStorage(),
  workflows: [NoteWorkflow],
  providers: [PlannedIdGenerator],
  budgets: TEST_BUDGETS,
})
export class SqlitePlannedIdsApplication {}
