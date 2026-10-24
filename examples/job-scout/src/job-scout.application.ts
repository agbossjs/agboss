import {
  Application,
  SqliteCheckpointSaver,
  SqliteChildExecutionQueueRepository,
  SqliteCostLedgerRepository,
  SqliteExecutionHistoryRepository,
  SqliteExecutionLeaseRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqliteMeshRequestRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
} from "agboss";
import { DecisionsModelProvider } from "agboss/models";
import { hours } from "agboss/units";
import {
  ApplicationDailyBudget,
  ExecutionBudget,
  TenantDailyBudget,
} from "./config/budget.config.js";
import { DEFAULTS } from "./config/settings.js";
import { AppEnvironment } from "./environments/app.environment.js";
import { JobScout } from "./job-scout.workflow.js";
import { OpenRouterModelProvider } from "./model-providers/openrouter.model-provider.js";

/**
 * job-scout as an application (#261): what `createApp`, `testWith` and the CLI run. Its
 * infrastructure is the SQLite implementations (#265) on the environment's `sqlitePath` — records,
 * spend, pauses, checkpoints, leases, tree keys and rate-limit slots in one file, so `--thread`,
 * `eval`, `replay` and `golden` see earlier processes, and another instance on the file recovers
 * a run whose process died; tests run on `:memory:`. Its model providers (#266) are listed here too:
 * its own OpenRouter for chat, the framework's Decisions API for Jev — every model of every workflow
 * resolves to one of them by `serves`. Its environments are in `environments/` next
 * to this file, typed by `AppEnvironment`; its `defaults` are every workflow's, under each
 * workflow's own.
 */
@Application({
  name: "job-scout-application",
  version: "1.0.0",
  environment: AppEnvironment,
  defaults: DEFAULTS,
  uncompactedTurns: 5, // every workflow's window, under its own
  workflows: [JobScout],
  providers: [
    OpenRouterModelProvider,
    DecisionsModelProvider,
    SqliteExecutionRecordRepository,
    SqliteCostLedgerRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteExecutionLeaseRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
    SqliteMeshRequestRepository,
    SqliteExecutionHistoryRepository,
    SqliteChildExecutionQueueRepository,
  ],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
  executionRecordRetention: hours(24 * 30), // each execution's history, 30 days: agboss records export
})
export class JobScoutApplication {}
