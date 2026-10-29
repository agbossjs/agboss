import {
  Application,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionHistoryRepository,
  SqliteExecutionRecordRepository,
} from "@agboss/core";
import { hours } from "@agboss/core/units";
import {
  ApplicationDailyBudget,
  ExecutionBudget,
  TenantDailyBudget,
} from "./config/budget.config.js";
import { DeskA2AExpose } from "./desk/a2a/desk.a2a-expose.js";
import { DeskWorkflow } from "./desk/workflows/desk/desk.workflow.js";
import { OrderDeskHealthCheck } from "./desk/health-checks/order-desk.health-check.js";
import { DeskMetricsObserver } from "./desk/observers/desk-metrics.observer.js";
import { DeskMetricsService } from "./desk/services/desk-metrics.service.js";
import { AppEnvironment } from "./environments/app.environment.js";
import { HarnessModelProvider } from "./model-providers/harness.model-provider.js";

/**
 * The help desk as an application of its own — offline: its only model provider is the transport
 * `HarnessModelProvider` (#385), so `npx agboss run --application src/desk.application.ts --env test`
 * and its eval suites run with no key and no network. `FlowPatternsApplication` lists the same
 * workflow beside OpenRouter. It serves the desk over A2A (`DeskA2AExpose`): the helpline of
 * `FlowPatternsApplication` is its consumer, checked by `agboss check --federation`. It keeps each
 * execution for 30 days (#401): `agboss records export` writes them, `agboss generate eval-case
 * --from-execution` and `agboss eval ui`'s "Save as golden case" (#397 PR 5) draft a case from one.
 */
@Application({
  name: "desk-application",
  version: "1.0.0",
  environment: AppEnvironment,
  pseudonymKey: "piiPseudonymKey",
  workflows: [DeskWorkflow],
  exposes: [DeskA2AExpose], // served over A2A: `helpline-workflow` calls it
  observers: [DeskMetricsObserver],
  healthChecks: [OrderDeskHealthCheck],
  maxConcurrentSteps: 16, // agent, router and action steps of one instance at once (#332)
  executionRecordRetention: hours(24 * 30), // each execution kept 30 days (#401): records export, eval cases
  providers: [
    DeskMetricsService, // the observer's
    HarnessModelProvider,
    SqliteCostLedgerRepository,
    SqliteExecutionRecordRepository,
    SqliteCheckpointSaver,
    SqliteExecutionHistoryRepository, // the kept executions (#401)
  ],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
})
export class DeskApplication {}
