import { Application } from "agboss";
import {
  ApplicationDailyBudget,
  ExecutionBudget,
  TenantDailyBudget,
} from "./config/budget.config.js";
import { JobScout } from "./job-scout.workflow.js";

/**
 * job-scout as an application (#261): what `createApp`, `testWith` and the CLI run. No
 * infrastructure is listed, so records, spend, pauses and checkpoints live in memory — nothing is
 * written to the home folder. Its environments are in `environments/` next to this file.
 */
@Application({
  name: "job-scout-application",
  version: "1.0.0",
  workflows: [JobScout],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
})
export class JobScoutApplication {}
