import type { ApplicationContainer, ContainerOptions } from "../components/container/container.js";
import type { ExecutionObserver } from "../core/observer-hooks.js";
import { ExecutionObserverManager, type ObserverFailure } from "../core/observer-manager.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { resolveListed } from "./application-container.js";
import type { AssembledApplication } from "./assemble.js";
import type { MeterProvider } from "@opentelemetry/api";
import type { StepCapacity } from "../app/step-slots.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import { lazyLoad } from "../infrastructure/clock.js";
import type { InstanceMetrics } from "../metrics/instance-metrics.js";
import { leaseEventLogOf, type LeaseEventLog } from "../app/execution-leases.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";

/**
 * The observers of an application instance (#261): `@Application({ observers })` only, one instance
 * each from its container, one manager for every workflow — child executions included. A hook that
 * throws is a warning in the application's log (`observer.failed`); the execution goes on.
 */

/** A failing hook, as a warning in the log. */
const failureLoggedTo =
  (log: FrameworkLog): ObserverFailure =>
  (observer, hook, error) => {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("observer.failed", `${observer}.${hook} threw: ${message}`);
  };

/** Observers of an instance besides the application's (a test's call recorder, #262). */
export interface ObserverSeams {
  readonly observers?: readonly ExecutionObserver[];
}

/** The instance's metrics (#485): their observer is called unmasked, before the others. */
export interface MeteredObserver {
  readonly observer: ExecutionObserver;
}

/** What an instance's metrics read, and where its created parts are kept (their `onDestroy`). */
export interface MeteredParts {
  readonly infrastructure: Infrastructure;
  readonly log: FrameworkLog;
  readonly instance: { readonly stepSlots?: StepCapacity | undefined };
  readonly created: unknown[];
}

/** What an instance's observers and lease log are made of. */
export interface ObservedParts extends MeteredParts {
  readonly assembled: AssembledApplication;
  readonly shared: ApplicationContainer;
  readonly seams: ObserverSeams;
  /** The application's PII observability mask. */
  readonly mask: ObservabilityMask;
}

/**
 * The instance's observer manager — its metrics' observer first when it is given a meter provider
 * (#485) — and its lease log (#501), where its held leases count themselves.
 */
export async function observersOf(
  parts: ObservedParts,
  options: ContainerOptions,
  { meterProvider }: { readonly meterProvider?: MeterProvider | undefined },
): Promise<{ readonly observer: ExecutionObserverManager; readonly leaseEvents: LeaseEventLog }> {
  const { assembled, shared, log, seams, mask, infrastructure } = parts;
  const metrics = await instanceMetricsOf(meterProvider, parts);
  const observer = observerManagerOf(assembled, shared, options, log, seams, metrics);
  const heldLeases = metrics?.heldLeases;
  return {
    observer,
    leaseEvents: leaseEventLogOf(infrastructure, { observer, mask, log, heldLeases }),
  };
}

/**
 * The instance's metrics on `meterProvider` (#485) — loaded only when the app is given one (the
 * root import keeps the option's type); kept with its created parts, so `app.close()` ends them.
 */
export async function instanceMetricsOf(
  meterProvider: MeterProvider | undefined,
  { infrastructure, log, instance, created }: MeteredParts,
): Promise<InstanceMetrics | undefined> {
  if (meterProvider === undefined) return undefined;
  const { InstanceMetrics: Metrics } = await lazyLoad(import("../metrics/instance-metrics.js"));
  const { childQueue: queue, clock } = infrastructure;
  const metrics = new Metrics({ meterProvider, queue, clock, log, stepSlots: instance.stepSlots });
  created.push(metrics);
  return metrics;
}

/** The manager of the application's observers, each created now (its hooks run with the others'). */
export function observerManagerOf(
  assembled: AssembledApplication,
  application: ApplicationContainer,
  options: ContainerOptions,
  log: FrameworkLog,
  seams: ObserverSeams = {},
  metrics?: MeteredObserver,
): ExecutionObserverManager {
  // each listed class is checked at assembly to implement observer hooks
  const observers = resolveListed(application, options, assembled.observers) as ExecutionObserver[];
  const all = [...observers, ...(seams.observers ?? [])];
  const builtIn = metrics === undefined ? [] : [metrics.observer];
  return new ExecutionObserverManager(all, failureLoggedTo(log), undefined, builtIn);
}
