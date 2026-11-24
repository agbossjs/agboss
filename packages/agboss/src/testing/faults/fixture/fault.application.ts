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
import { FAULT_BUSINESS_ROWS, type FaultStoreSet } from "../fault-stores.js";
import { heldMethodsOf, withHoldPoints } from "../held-stores.js";
import { FaultModelProvider } from "./fault.model-provider.js";
import { FaultObserver } from "./fault.observer.js";
import { FaultBatchWorkflow, FaultOrderWorkflow } from "./order.workflow.js";
import { FaultApprovalWorkflow, FaultCallerChannel } from "./approval.workflow.js";
import {
  FaultExpiringChannel,
  FaultExpiringWorkflow,
  FaultPauseChannel,
  FaultPauseWorkflow,
} from "./pause.workflow.js";
import { FaultPauseListener } from "./pause.listener.js";
import {
  FaultChildPauseWorkflow,
  FaultSecondPauseChannel,
  FaultTwicePauseWorkflow,
} from "./window.workflow.js";
import { FaultA2AEndpoint, FaultAuthenticator, keepsA2ATasks } from "./fault.a2a.js";
import { breaksContract, isOutsideHolds, sabotagedStoreOf } from "../sabotage-stores.js";
import type { FaultStoreSabotage } from "../pod-protocol.js";
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
  /** A fenced-effect store broken on purpose (#959). */
  readonly sabotage?: FaultStoreSabotage | undefined;
  readonly shutdownTimeout?: Milliseconds | undefined;
  readonly maxConcurrentSteps?: number | undefined;
  /** The expiring order and its channel are listed too (#941). */
  readonly hasExpiringOrders?: boolean | undefined;
}

/** The store classes as the pod lists them: each of a held contract with its hold points. */
export const heldProvidersOf = (
  providers: readonly Class[],
  sabotage?: FaultStoreSabotage,
): Class[] =>
  providers.map((provider) => {
    const methods = heldMethodsOf(provider);
    if (methods === undefined) return provider;
    if (sabotage === undefined || !breaksContract(sabotage, methods))
      return withHoldPoints(provider);
    // #928 S2b: a sabotage that answers over a hold wraps the held store
    return isOutsideHolds(sabotage)
      ? sabotagedStoreOf(withHoldPoints(provider), sabotage)
      : withHoldPoints(sabotagedStoreOf(provider, sabotage));
  });

/**
 * What the application adds to serve A2A (#811 AC4) on a store set that keeps A2A tasks: the
 * approved order's workflow, the expose, its caller resolver and the question's channel; none on
 * another set, whose application stays as it was.
 */
interface FaultA2AParts {
  readonly workflows: readonly Class[];
  readonly endpoints: readonly Class[];
  readonly providers: readonly Class[];
}

function a2aPartsOf(stores: FaultStoreSet): FaultA2AParts {
  if (!keepsA2ATasks(stores.providers)) return { workflows: [], endpoints: [], providers: [] };
  return {
    workflows: [FaultApprovalWorkflow],
    endpoints: [FaultA2AEndpoint],
    providers: [FaultAuthenticator, FaultCallerChannel],
  };
}

/** The fixture's application on `stores`, with the pod's `settings`. */
export function faultApplicationOf(stores: FaultStoreSet, settings: FaultPodSettings = {}): Class {
  const { shutdownTimeout, maxConcurrentSteps, sabotage, hasExpiringOrders } = settings;
  const expiring = hasExpiringOrders === true;
  const a2a = a2aPartsOf(stores);
  return Application({
    name: "fault-application",
    version: "1.0.0",
    environment: faultEnvironmentOf(stores.environment.contract),
    workflows: [
      FaultOrderWorkflow,
      FaultBatchWorkflow,
      FaultPauseWorkflow,
      FaultChildPauseWorkflow,
      FaultTwicePauseWorkflow,
      ...(expiring ? [FaultExpiringWorkflow] : []),
      ...a2a.workflows,
    ],
    ...(a2a.endpoints.length === 0 ? {} : { endpoints: a2a.endpoints }),
    observers: [FaultObserver],
    budgets: [FaultApplicationBudget, FaultTenantBudget, FaultExecutionBudget],
    retention: { executionRecords: hours(24) },
    ...(shutdownTimeout === undefined && maxConcurrentSteps === undefined
      ? {}
      : {
          executionLimits: {
            ...(shutdownTimeout === undefined ? {} : { shutdownTimeout }),
            ...(maxConcurrentSteps === undefined ? {} : { maxConcurrentSteps }),
          },
        }),
    providers: [
      ...heldProvidersOf(stores.providers, sabotage),
      FaultPodClock,
      FaultModelProvider,
      FaultPodLink,
      FaultPauseChannel,
      FaultSecondPauseChannel,
      ...(expiring ? [FaultExpiringChannel] : []),
      FaultPauseListener,
      provide(FAULT_BUSINESS_ROWS, stores.businessRows),
      ...a2a.providers,
    ],
  })(faultApplicationClass());
}

/** The idempotency key every pod of a run fingerprints with (#825): the same in each. */
export const FAULT_IDEMPOTENCY_KEYS = Object.freeze({
  current: "agboss-fault-suite-idempotency-key",
});

const environments = new WeakMap<Class, Class>();

/**
 * The store set's environment contract with the fixture's idempotency key (#825): a store set
 * declares only its own fields; the fixture adds the one its business keys need.
 */
export function faultEnvironmentOf(contract: Class): Class {
  const known = environments.get(contract);
  if (known !== undefined) return known;
  const base = contract as new () => object;
  class FaultEnvironment extends base {
    faultIdempotencyKey: unknown = undefined;
  }
  environments.set(contract, FaultEnvironment);
  return FaultEnvironment;
}

/** A new class for the application to decorate (one per pod). */
const faultApplicationClass = (): Class =>
  class FaultApplication {
    readonly kind = "fault-application";
  };
