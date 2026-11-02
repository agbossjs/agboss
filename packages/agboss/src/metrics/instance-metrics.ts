import type {
  BatchObservableCallback,
  Meter,
  MeterProvider,
  Observable,
  ObservableGauge,
} from "@opentelemetry/api";
import type { StepCapacity } from "../app/step-slots.js";
import type { ExecutionObserver } from "../core/observer-hooks.js";
import type { ChildExecutionQueueRepository } from "../infrastructure/child-execution-queue.repository.js";
import type { Clock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { frameworkPackageJson } from "../package-json.js";
import { METRICS, type MetricSpec } from "./metric-catalog.js";
import { metricsObserverOf } from "./metrics-observer.js";
import { HeldLeaseTally } from "./held-lease-tally.js";

/**
 * An application instance's metrics (#485), on the `Meter` of the `meterProvider` given to
 * `createApp` — loaded only then: the cluster's queued children (one `findQueueDepth()` per
 * collection, a batch callback), the instance's step slots and held leases (read at collection),
 * and its counters (a built-in observer). `onDestroy` removes the callbacks before the stores close:
 * a closed instance never reads a store.
 */

/** The meter's instrumentation scope: the framework, at its version. */
export const METER_NAME = "@agboss/core";

/** What the instance's metrics read. */
export interface MetricSources {
  readonly meterProvider: MeterProvider;
  readonly queue: ChildExecutionQueueRepository;
  readonly clock: Clock;
  readonly log: FrameworkLog;
  /** The instance's step slots; absent = no `maxConcurrentSteps`, no slot gauges. */
  readonly stepSlots?: StepCapacity | undefined;
}

const versionOf = (): string => {
  const parsed = frameworkPackageJson();
  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? parsed.version
      : undefined;
  return typeof version === "string" ? version : "unknown";
};

const gaugeOf = (meter: Meter, spec: MetricSpec): ObservableGauge =>
  meter.createObservableGauge(spec.name, { unit: spec.unit, description: spec.description });

/** One batch callback and the instruments it observes. */
interface Registration {
  readonly callback: BatchObservableCallback;
  readonly observables: Observable[];
}

/** The cluster gauges: one store read per collection; a failed read reports none of them. */
function clusterGaugesOf(meter: Meter, sources: MetricSources): Registration {
  const queued = gaugeOf(meter, METRICS.childrenQueued);
  const running = gaugeOf(meter, METRICS.childrenRunning);
  const oldest = gaugeOf(meter, METRICS.oldestQueued);
  let isFailing = false;
  const callback: BatchObservableCallback = async (result) => {
    try {
      const depth = await sources.queue.findQueueDepth();
      isFailing = false;
      const waitedFrom = depth.oldestQueuedAt?.getTime();
      const waited = waitedFrom === undefined ? 0 : sources.clock.now().getTime() - waitedFrom;
      result.observe(queued, depth.queued);
      result.observe(running, depth.running);
      result.observe(oldest, Math.max(0, waited) / 1000);
    } catch (error) {
      if (!isFailing) {
        const message = `the child queue could not be read for the metrics: ${String(error)}`;
        sources.log.warn("metrics.child-queue-unreadable", message);
      }
      isFailing = true;
    }
  };
  return { callback, observables: [queued, running, oldest] };
}

/** The instance's own gauges: its held leases, and its step slots when it caps them. */
function instanceGaugesOf(
  meter: Meter,
  sources: MetricSources,
  heldLeases: HeldLeaseTally,
): Registration {
  const held = gaugeOf(meter, METRICS.leasesHeld);
  const slots = sources.stepSlots;
  if (slots === undefined) {
    const callback: BatchObservableCallback = (result) => {
      result.observe(held, heldLeases.held);
    };
    return { callback, observables: [held] };
  }
  const limit = gaugeOf(meter, METRICS.slotLimit);
  const busy = gaugeOf(meter, METRICS.slotsBusy);
  const free = gaugeOf(meter, METRICS.slotsFree);
  const waiting = gaugeOf(meter, METRICS.stepsWaiting);
  const callback: BatchObservableCallback = (result) => {
    result.observe(held, heldLeases.held);
    result.observe(limit, slots.maxConcurrentSteps);
    result.observe(busy, slots.busySlots());
    result.observe(free, slots.freeSlots());
    result.observe(waiting, slots.waitingSteps());
  };
  return { callback, observables: [held, limit, busy, free, waiting] };
}

/** An instance's metrics on its meter: its counting observer, and the end of its callbacks. */
export class InstanceMetrics {
  readonly observer: ExecutionObserver;
  /** Where the instance's held leases count themselves. */
  readonly heldLeases = new HeldLeaseTally();
  readonly #meter: Meter;
  readonly #registrations: readonly Registration[];

  constructor(sources: MetricSources) {
    this.#meter = sources.meterProvider.getMeter(METER_NAME, versionOf());
    this.observer = metricsObserverOf(this.#meter);
    this.#registrations = [
      clusterGaugesOf(this.#meter, sources),
      instanceGaugesOf(this.#meter, sources, this.heldLeases),
    ];
    for (const { callback, observables } of this.#registrations)
      this.#meter.addBatchObservableCallback(callback, observables);
  }

  /** At `app.close()`, before the stores close: no collection reads this instance again. */
  onDestroy(): void {
    for (const { callback, observables } of this.#registrations)
      this.#meter.removeBatchObservableCallback(callback, observables);
  }
}
