import { InMemoryFencedEffectRepository } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { RecordingLogger } from "../../helpers/log.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import {
  ChargeWorkflow,
  DoubleChargeWorkflow,
  FencedExecutionBudget,
} from "./fenced-effect.workflow.js";
import { HeldLeases, ScopedAudit, ScopedCheckpoints } from "./lease-scope-bound.application.js";

/** #928 — the charge workflow on an audit log whose rows and a checkpointer whose puts can be held for ever (`hangNext("audit.save")`). */
@Application({
  name: "lease-scope-audit-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow, DoubleChargeWorkflow],
  observers: [RecoveryLog],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, FencedExecutionBudget],
  providers: [
    ScopedAudit,
    ScopedCheckpoints,
    HeldLeases,
    RecordingLogger,
    InMemoryFencedEffectRepository,
  ],
})
export class LeaseScopeAuditApplication {}
