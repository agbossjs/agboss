/**
 * The metrics an application instance publishes through the OpenTelemetry `Meter` it is given
 * (#485, Wiki → Metrics): stable names, kinds, units and label keys — a contract a dashboard, a KEDA
 * trigger or an HPA reads, changed only with an announcement. Cluster values (`agboss.cluster.*`)
 * are read from the shared store and the same on every instance: aggregate them with `max`, never
 * `sum`; per-instance values (`agboss.instance.*`) with `sum`.
 */

/** How a metric is recorded. */
export enum MetricKind {
  /** A value read at each collection. */
  ObservableGauge = "observable-gauge",
  /** A count that only grows, since the instance started. */
  Counter = "counter",
}

/** One metric: what a reader finds under `name`. */
export interface MetricSpec {
  readonly name: string;
  readonly kind: MetricKind;
  /** UCUM, `{…}` an annotation (dropped by the Prometheus exporter). */
  readonly unit: string;
  readonly description: string;
  /** Its label keys: each bounded by the code (enums, the application's workflow names). */
  readonly labels: readonly string[];
}

const gauge = (name: string, unit: string, description: string): MetricSpec => ({
  name,
  kind: MetricKind.ObservableGauge,
  unit,
  description,
  labels: [],
});

const counter = (
  name: string,
  unit: string,
  description: string,
  labels: readonly string[],
): MetricSpec => ({ name, kind: MetricKind.Counter, unit, description, labels });

/** Every metric, by its role. */
export const METRICS = {
  childrenQueued: gauge(
    "agboss.cluster.children.queued",
    "{execution}",
    "Children launched on any instance waiting to be claimed, over the whole application (aggregate with max)",
  ),
  childrenRunning: gauge(
    "agboss.cluster.children.running",
    "{execution}",
    "Children launched on any instance claimed by an instance, over the whole application (aggregate with max)",
  ),
  oldestQueued: gauge(
    "agboss.cluster.children.oldest_queued.age",
    "s",
    "How long the longest-waiting queued child has waited; 0 when none (aggregate with max)",
  ),
  slotLimit: gauge(
    "agboss.instance.step_slots.limit",
    "{slot}",
    "The instance's maxConcurrentSteps",
  ),
  slotsBusy: gauge("agboss.instance.step_slots.busy", "{slot}", "Steps at work on the instance"),
  slotsFree: gauge("agboss.instance.step_slots.free", "{slot}", "Step slots no step holds"),
  stepsWaiting: gauge(
    "agboss.instance.steps.waiting",
    "{step}",
    "Steps waiting for a step slot on the instance",
  ),
  leasesHeld: gauge(
    "agboss.instance.leases.held",
    "{lease}",
    "Execution-tree leases the instance holds: roots it moves, children it claimed",
  ),
  takeovers: counter(
    "agboss.instance.leases.takeovers",
    "{takeover}",
    "Tree leases the instance took over, by reason (recoveries: recovered, unwinding)",
    ["reason"],
  ),
  handedOver: counter(
    "agboss.instance.steps.handed_over",
    "{step}",
    "Steps the instance handed over without failing, by reason",
    ["reason"],
  ),
  executionsEnded: counter(
    "agboss.instance.executions.ended",
    "{execution}",
    "Executions that ended on the instance, children included, by workflow and outcome",
    ["workflow", "outcome"],
  ),
  unknownCosts: counter(
    "agboss.instance.costs.unknown",
    "{pass}",
    "Lost passes of a step whose cost is not known (a crash mid model call, run again by a recovery), counted as the instance's pass records their Unknown-cost entries — whether the execution then finishes, fails or is cancelled — by workflow",
    ["workflow"],
  ),
  unknownCostsUnrecorded: counter(
    "agboss.instance.costs.unknown_unrecorded",
    "{read}",
    "Takeovers on the instance whose read of the tree's lost passes failed, so none of their Unknown-cost entries is recorded (logged as cost.unknown-unrecorded), by workflow",
    ["workflow"],
  ),
  storeCallsTimedOut: counter(
    "agboss.instance.store_calls.timed_out",
    "{call}",
    "Store calls the instance gave up on at their bound (#928), by contract, operation, source (framework, command) and kind (leased, unleased, long)",
    ["contract", "operation", "source", "kind"],
  ),
  compensations: counter(
    "agboss.instance.compensations",
    "{action}",
    "Automatic undo actions that ended on the instance, by workflow and outcome (its CompensationStatus)",
    ["workflow", "outcome"],
  ),
} as const satisfies Readonly<Record<string, MetricSpec>>;

/** How an execution ended, as `agboss.instance.executions.ended` labels it. */
export enum ExecutionOutcome {
  Finished = "finished",
  Failed = "failed",
  Cancelled = "cancelled",
}
