import type { Counter, Meter } from "@opentelemetry/api";
import type { ExecutionEndEvent, ExecutionErrorEvent } from "../core/observability.js";
import type { ExecutionObserver } from "../core/observer-hooks.js";
import { ExecutionCancelledError } from "../core/errors.js";
import type { CompensationEndEvent } from "../flow/observers/compensation-events.js";
import type {
  ExecutionLeaseTakeoverEvent,
  StepHandedOverEvent,
} from "../flow/observers/lease-events.js";
import { ExecutionOutcome, METRICS, type MetricSpec } from "./metric-catalog.js";

/**
 * The instance's counters (#485): a built-in observer, called unmasked before the project's — it
 * reads enums and workflow names only, never a tenant, an id or a message.
 */

const counterOf = (meter: Meter, spec: MetricSpec): Counter =>
  meter.createCounter(spec.name, { unit: spec.unit, description: spec.description });

/** `agboss.instance.executions.ended`'s outcome of a failure: a cancel, or a failure. */
const outcomeOf = (error: Error): ExecutionOutcome =>
  error instanceof ExecutionCancelledError ? ExecutionOutcome.Cancelled : ExecutionOutcome.Failed;

/** The counting observer on `meter`. */
export function metricsObserverOf(meter: Meter): ExecutionObserver {
  const takeovers = counterOf(meter, METRICS.takeovers);
  const handedOver = counterOf(meter, METRICS.handedOver);
  const ended = counterOf(meter, METRICS.executionsEnded);
  const compensations = counterOf(meter, METRICS.compensations);
  const unknownCosts = counterOf(meter, METRICS.unknownCosts);
  return {
    onExecutionLeaseTakeover: (event: ExecutionLeaseTakeoverEvent) => {
      takeovers.add(1, { reason: event.reason });
    },
    onStepHandedOver: (event: StepHandedOverEvent) => {
      handedOver.add(1, { reason: event.reason });
    },
    onExecutionEnd: (event: ExecutionEndEvent) => {
      ended.add(1, { workflow: event.workflow.name, outcome: ExecutionOutcome.Finished });
      // #853: its lost passes, once — an execution's end is announced once
      const { unknownCalls } = event.spend;
      if (unknownCalls > 0) unknownCosts.add(unknownCalls, { workflow: event.workflow.name });
    },
    onExecutionError: (event: ExecutionErrorEvent) => {
      ended.add(1, { workflow: event.workflow.name, outcome: outcomeOf(event.error) });
    },
    onCompensationEnd: (event: CompensationEndEvent) => {
      compensations.add(1, { workflow: event.workflow.name, status: event.status });
    },
  };
}
