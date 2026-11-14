import type { Counter, Meter } from "@opentelemetry/api";
import type { ExecutionEndEvent, ExecutionErrorEvent } from "../core/observability.js";
import type { ExecutionObserver } from "../core/observer-hooks.js";
import type { UnknownCostTally } from "../core/observer-manager.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { ExecutionCancelledError } from "../core/errors.js";
import type { CompensationEndEvent } from "../flow/observers/compensation-events.js";
import type {
  ExecutionLeaseTakeoverEvent,
  StepHandedOverEvent,
} from "../flow/observers/audit-log.js";
import { ExecutionOutcome, METRICS, type MetricSpec } from "./metric-catalog.js";

/**
 * The instance's counters (#485): a built-in observer, called unmasked before the project's — it
 * reads enums and workflow names only, never a tenant, an id or a message.
 */

export const counterOf = (meter: Meter, spec: MetricSpec): Counter =>
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
  return {
    onExecutionLeaseTakeover: (event: ExecutionLeaseTakeoverEvent) => {
      takeovers.add(1, { reason: event.reason });
    },
    onStepHandedOver: (event: StepHandedOverEvent) => {
      handedOver.add(1, { reason: event.reason });
    },
    onExecutionEnd: (event: ExecutionEndEvent) => {
      ended.add(1, { workflow: event.workflow.name, outcome: ExecutionOutcome.Finished });
    },
    onExecutionError: (event: ExecutionErrorEvent) => {
      ended.add(1, { workflow: event.workflow.name, outcome: outcomeOf(event.error) });
    },
    onCompensationEnd: (event: CompensationEndEvent) => {
      compensations.add(1, { workflow: event.workflow.name, outcome: event.status });
    },
  };
}

/**
 * The instance's tally of Unknown-cost entries on `meter` (#875): counted as a pass records them,
 * whatever the execution's end — a failed or cancelled one too; a failed read of the lost passes
 * counted apart, as its entries are not recorded. A counter that throws is a warning in `log`
 * (`metrics.unknown-cost-uncounted`), never the step's or the takeover's failure.
 */
export function unknownCostTallyOf(meter: Meter, log: FrameworkLog): UnknownCostTally {
  const recorded = counterOf(meter, METRICS.unknownCosts);
  const unrecorded = counterOf(meter, METRICS.unknownCostsUnrecorded);
  const add = (counter: Counter, count: number, workflow: string): void => {
    try {
      counter.add(count, { workflow });
    } catch (error) {
      const message = `an Unknown-cost count of workflow ${workflow} was not added: ${String(error)}`;
      log.warn("metrics.unknown-cost-uncounted", message);
    }
  };
  return {
    recorded: (workflow, count) => {
      if (count > 0) add(recorded, count, workflow);
    },
    unrecorded: (workflow) => {
      add(unrecorded, 1, workflow);
    },
  };
}
