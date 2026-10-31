import {
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  provide,
  type BudgetHandler,
} from "../../../index.js";
import type { Class } from "../../../components/injection.js";
import { hours, usd, type Milliseconds, type Usd } from "../../../units/index.js";
import { FaultPodClock } from "../fault-clock.js";
import { FAULT_BUSINESS_ROWS, type FaultStores } from "../fault-stores.js";
import { heldMethodsOf, withHoldPoints } from "../held-stores.js";
import { FaultModelProvider } from "./fault.model-provider.js";
import { FaultObserver } from "./fault.observer.js";
import { FaultBatchWorkflow, FaultOrderWorkflow } from "./order.workflow.js";
import { FaultPodLink } from "./pod-link.js";

/**
 * The fault fixture's application (#484), built in each pod around the store set it is given:
 * the order and batch workflows, the observer that tells the test what happened, every store of
 * the set — the fencing stores and the child queue with their hold points —, the pod's scaled
 * clock, the business rows, and the pod's own settings (its shutdown timeout, its step slots).
 * It keeps its executions' history, read by the invariant checker.
 */

@Budget({
  name: "fault-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class FaultApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(100);
  }
}

@Budget({ name: "fault-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class FaultTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(100);
  }
}

@Budget({ name: "fault-execution-budget", scope: BudgetScope.Execution })
export class FaultExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

/** What one pod sets of its application. */
export interface FaultPodSettings {
  readonly shutdownTimeout?: Milliseconds | undefined;
  readonly maxConcurrentSteps?: number | undefined;
}

/** The store classes as the pod lists them: each of a held contract with its hold points. */
export const heldProvidersOf = (providers: readonly Class[]): Class[] =>
  providers.map((provider) =>
    heldMethodsOf(provider) === undefined ? provider : withHoldPoints(provider),
  );

/** The fixture's application on `stores`, with the pod's `settings`. */
export function faultApplicationOf(stores: FaultStores, settings: FaultPodSettings = {}): Class {
  const { shutdownTimeout, maxConcurrentSteps } = settings;
  return Application({
    name: "fault-application",
    version: "1.0.0",
    environment: stores.environment.contract,
    workflows: [FaultOrderWorkflow, FaultBatchWorkflow],
    observers: [FaultObserver],
    budgets: [FaultApplicationBudget, FaultTenantBudget, FaultExecutionBudget],
    executionRecordRetention: hours(24),
    ...(shutdownTimeout === undefined ? {} : { shutdownTimeout }),
    ...(maxConcurrentSteps === undefined ? {} : { maxConcurrentSteps }),
    providers: [
      ...heldProvidersOf(stores.providers),
      FaultPodClock,
      FaultModelProvider,
      FaultPodLink,
      provide(FAULT_BUSINESS_ROWS, stores.businessRows),
    ],
  })(faultApplicationClass());
}

/** A new class for the application to decorate (one per pod). */
const faultApplicationClass = (): Class =>
  class FaultApplication {
    readonly kind = "fault-application";
  };
