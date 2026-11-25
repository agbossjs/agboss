import { SqliteExecutionHistoryRepository } from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { hours } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import {
  DeskExecutionContext,
  DeskTenantContext,
  EvalDeskWorkflow,
} from "../../../flow/fixtures/eval-desk.fixture.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/**
 * #401 PR 1 — the refunds desk keeping its root executions' history on the SQLite file
 * (`AGBOSS_SQLITE_TEST_PATH`): what `agboss executions export` reads.
 */
@Application({
  name: "sqlite-history-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [EvalDeskWorkflow],
  tenantContext: DeskTenantContext,
  executionContext: DeskExecutionContext,
  providers: [SqliteExecutionHistoryRepository],
  budgets: TEST_BUDGETS,
  retention: { executionRecords: hours(24) },
})
export class SqliteHistoryApplication {}
