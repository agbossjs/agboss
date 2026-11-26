import { SqliteCostLedgerRepository } from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { PaidHoldWorkflow } from "../../../budgets/fixtures/paid-launches.workflow.js";
import { PaidFinishWorkflow } from "../../../budgets/fixtures/paid-steps.workflow.js";
import { PaidStepsLog } from "../../../budgets/fixtures/paid-steps.actions.js";
import { sqliteTestStorage } from "./sqlite-test-storage.js";

/**
 * #634 — a held order and an overspend on one SQLite file's ledger: each instance its own
 * connection, so one sees the other's spend only through the file.
 */
@Application({
  name: "sqlite-paid-steps-application",
  version: "1.0.0",
  storage: sqliteTestStorage({ only: [SqliteCostLedgerRepository] }),
  workflows: [PaidHoldWorkflow, PaidFinishWorkflow],
  observers: [PaidStepsLog],
  budgets: TEST_BUDGETS,
})
export class SqlitePaidStepsApplication {}
