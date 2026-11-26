import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../../helpers/log.js";
import { YieldLog, YieldOneWorkflow } from "../../../app/fixtures/remote-child-yield.workflow.js";
import { sqliteTestStorage } from "./sqlite-test-storage.js";

/** #917 — one `AnyWorker` child on two instances over one SQLite file, every store SQLite. */
@Application({
  name: "remote-wake-sqlite-application",
  version: "1.0.0",
  storage: sqliteTestStorage(),
  workflows: [YieldOneWorkflow],
  observers: [YieldLog],
  budgets: TEST_BUDGETS,
  executionLimits: { maxConcurrentSteps: 1 },
  providers: [RecordingLogger],
})
export class RemoteWakeSqliteApplication {}
