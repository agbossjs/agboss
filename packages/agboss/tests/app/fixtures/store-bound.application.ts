import { InMemoryFencedEffectRepository } from "../../../src/index.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { Application } from "../../../src/application/application.js";
import { withHoldPoints } from "../../../src/testing/faults/held-stores.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import {
  ChargeWorkflow,
  DoubleChargeWorkflow,
  FencedExecutionBudget,
} from "./fenced-effect.workflow.js";

/**
 * #928 — the charge workflow on stores that can hold a call for ever (`withHoldPoints`, deaf to the
 * step's signal, as a silent peer is): the lease store and the fenced-effect store.
 */
export const HeldLeases = withHoldPoints(InMemoryExecutionLeaseRepository);
export const HeldFencedEffects = withHoldPoints(InMemoryFencedEffectRepository);

@Application({
  name: "store-bound-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow, DoubleChargeWorkflow],
  observers: [RecoveryLog],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, FencedExecutionBudget],
  providers: [HeldLeases, HeldFencedEffects],
})
export class StoreBoundApplication {}
