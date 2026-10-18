import { Application } from "agboss";
import {
  ApplicationDailyBudget,
  ExecutionBudget,
  TenantDailyBudget,
} from "./config/budget.config.js";
import { DEFAULTS } from "./config/settings.js";
import { AppEnvironment } from "./environments/app.environment.js";
import { JobScout } from "./job-scout.workflow.js";

/**
 * job-scout as an application (#261): what `createApp`, `testWith` and the CLI run. No
 * infrastructure is listed, so records, spend, pauses and checkpoints live in memory — nothing is
 * written to the home folder. Its environments are in `environments/` next to this file, typed by
 * `AppEnvironment`; its `defaults` are every workflow's, under each workflow's own.
 */
@Application({
  name: "job-scout-application",
  version: "1.0.0",
  environment: AppEnvironment,
  defaults: DEFAULTS,
  workflows: [JobScout],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
})
export class JobScoutApplication {}
