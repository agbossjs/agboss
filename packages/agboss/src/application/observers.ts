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
import { executionControlOf } from "../app/execution-control.js";
import { componentOf } from "../components/metadata.js";

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
  const projection = await a2aTaskProjectionOf(parts);
  const builtIn = [...(metrics === undefined ? [] : [metrics.observer]), ...projection];
  const observer = observerManagerOf(assembled, shared, options, log, seams, builtIn);
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

/**
 * The A2A task projection (#807), when the application exposes an `@A2AExpose` — loaded only then:
 * the framework's own observer, called first and unmasked (it keeps the pauses' masked asks as the
 * execution lists them, and a finish's output as the caller gets it).
 */
async function a2aTaskProjectionOf(parts: ObservedParts): Promise<readonly ExecutionObserver[]> {
  const exposes = parts.assembled.exposes.some((cls) => componentOf(cls)?.kind === "a2a-expose");
  if (!exposes) return [];
  const { A2ATaskProjection } = await lazyLoad(import("../a2a/tasks/a2a-task-projection.js"));
  const { a2aTasks, clock } = parts.infrastructure;
  // the instance's trees by id, remembered by its infrastructure once its app is composed
  const control = () => executionControlOf(parts.infrastructure);
  return [new A2ATaskProjection(a2aTasks, clock, control)];
}

/**
 * The manager of the application's observers, each created now (its hooks run with the others'),
 * after the framework's own (`builtIn`: the instance's metrics, the A2A task projection).
 */
export function observerManagerOf(
  assembled: AssembledApplication,
  application: ApplicationContainer,
  options: ContainerOptions,
  log: FrameworkLog,
  seams: ObserverSeams = {},
  builtIn: readonly ExecutionObserver[] = [],
): ExecutionObserverManager {
  // each listed class is checked at assembly to implement observer hooks
  const observers = resolveListed(application, options, assembled.observers) as ExecutionObserver[];
  const all = [...observers, ...(seams.observers ?? [])];
  return new ExecutionObserverManager(all, failureLoggedTo(log), undefined, builtIn);
}
