import {
  ExecutionLeaseRepository,
  Injectable,
  InMemoryFencedEffectRepository,
} from "../../../src/index.js";
import type {
  EffectKey,
  FencedEffectOutcome,
  FencedEffectWork,
} from "../../../src/infrastructure/fenced-effect.repository.js";
import type { InMemoryFencedEffectTransaction } from "../../../src/stores/index.js";
import { StoreClock } from "../../../src/infrastructure/clock.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { currentFrame } from "../../../src/flow/context/frame.js";
import { Application } from "../../../src/application/application.js";
import { withHoldPoints } from "../../../src/testing/faults/held-stores.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { RecordingLogger } from "../../helpers/log.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { ChargeWorkflow, FencedExecutionBudget } from "./fenced-effect.workflow.js";

/** Whether the fenced write hangs, and how often it was asked (reset by the test). */
export const listening = { hangs: false, asked: 0 };

/**
 * #928 sabotage S1 — a fenced write that never answers but listens to its step's signal, as a
 * driver that honours an `AbortSignal` does: the lease's expiry frees it without any bound.
 */
@Injectable({
  deps: [StoreClock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository],
})
export class ListeningFencedEffects extends InMemoryFencedEffectRepository {
  override runOnce<TResult>(
    key: EffectKey,
    work: FencedEffectWork<InMemoryFencedEffectTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    listening.asked += 1;
    const signal = currentFrame()?.execution.lease?.signal;
    if (!listening.hangs || signal === undefined) return super.runOnce(key, work);
    return new Promise<never>((_, reject) => {
      const stop = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("the lease was lost"));
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
  }
}

@Application({
  name: "store-bound-listening-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow],
  observers: [RecoveryLog],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, FencedExecutionBudget],
  providers: [
    withHoldPoints(MortalExecutionLeaseRepository),
    ListeningFencedEffects,
    RecordingLogger,
  ],
})
export class StoreBoundListeningApplication {}
