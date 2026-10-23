import {
  Application,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionRecordRepository,
} from "agboss";
import {
  ApplicationDailyBudget,
  ExecutionBudget,
  TenantDailyBudget,
} from "./config/budget.config.js";
import { DeskWorkflow } from "./desk/desk.workflow.js";
import { AppEnvironment } from "./environments/app.environment.js";
import { HarnessModelProvider } from "./model-providers/harness.model-provider.js";

/**
 * The help desk as an application of its own — offline: its only model provider is the transport
 * `HarnessModelProvider` (#385), so `npx agboss run --application src/desk.application.ts --env test`
 * and its eval suites run with no key and no network. `FlowPatternsApplication` lists the same
 * workflow beside OpenRouter.
 */
@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: AppEnvironment,
  pseudonymKey: "piiPseudonymKey",
  workflows: [DeskWorkflow],
  providers: [
    HarnessModelProvider,
    SqliteCostLedgerRepository,
    SqliteExecutionRecordRepository,
    SqliteCheckpointSaver,
  ],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
})
export class DeskApplication {}
