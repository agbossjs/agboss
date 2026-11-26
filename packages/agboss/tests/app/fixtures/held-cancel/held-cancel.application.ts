import { Application } from "../../../../src/application/application.js";
import { sqliteTestStorage } from "../../../infrastructure/sqlite/fixtures/sqlite-test-storage.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  DirectorChannel,
  ManagerChannel,
  ShortManagerChannel,
  PlainWorkflow,
  ShortExpiryWorkflow,
} from "../../../flow/fixtures/expiry.fixture.js";
import { SlowPauseStore } from "./slow-pause-store.js";

/**
 * #1093: a workflow that rests on a question, every store on one SQLite file two processes open —
 * the process that holds the tree's lease, and a script that only calls `app.cancel`.
 */
@Application({
  name: "held-cancel-application",
  version: "1.0.0",
  // every SQLite store on the file `HELD_CANCEL_SQLITE_PATH` names, the paused-execution store the slow one
  storage: sqliteTestStorage({
    pathVariable: "HELD_CANCEL_SQLITE_PATH",
    keyed: false,
    replace: [SlowPauseStore],
  }),
  workflows: [PlainWorkflow, ShortExpiryWorkflow],
  budgets: TEST_BUDGETS,
  providers: [DirectorChannel, ManagerChannel, ShortManagerChannel, ShortManagerChannel],
})
export class HeldCancelApplication {}
