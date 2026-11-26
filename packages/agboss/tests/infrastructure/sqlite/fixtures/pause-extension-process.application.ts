import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  CHANNELS,
  ExtensionPauseListener,
  FLOWS,
} from "../../../flow/fixtures/pause-extension.fixture.js";
import { sqliteTestStorage } from "./sqlite-test-storage.js";

/**
 * #1099 — the extension fixture's workflows on the SQLite file with the real lease store, for the
 * processes of the racing-extensions test (the vitest fixtures' hooks are not loaded there).
 */
@Application({
  name: "sqlite-extension-process-application",
  version: "1.0.0",
  storage: sqliteTestStorage(),
  workflows: FLOWS,
  budgets: TEST_BUDGETS,
  providers: [...CHANNELS, ExtensionPauseListener],
})
export class SqliteExtensionProcessApplication {}
