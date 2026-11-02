import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { OrderedCheckpointSaver } from "../app/leased-checkpointer.js";
import { circuitOpenKeyOf } from "../models/circuit-breaker.js";
import { modelProviderOf } from "../models/model-provider.decorator.js";
import { seconds, type Milliseconds } from "../units/index.js";
import { componentReportOf, probe, type ProbeOutcome } from "./health-probe.js";
import { waitOf } from "../infrastructure/clock.js";
import { HealthComponentKind, HealthStatus, type HealthComponentReport } from "./health-check.js";
import type { HealthSources, ProjectHealthCheck } from "./health-sources.js";

/**
 * What only readiness checks (#300): every store's `ping()`, every model provider's circuit
 * breaker as `RateLimitRepository` keeps it (open → `Degraded`; never a model call) and every
 * project `@HealthCheck` — each under its own timeout, all at once.
 */

/** How long a store's `ping()` or a breaker's read may take. */
export const STORE_TIMEOUT: Milliseconds = seconds(2);

const HEALTHY: ProbeOutcome = { status: HealthStatus.Healthy };

/** The thread a checkpoint saver without `ping()` is asked for: a read that finds nothing. */
const PROBE_THREAD = { configurable: { thread_id: "agboss-health-check", checkpoint_ns: "" } };

/**
 * A checkpoint saver is LangGraph's contract, not ours: one with a `ping()` (the in-memory default,
 * `SqliteCheckpointSaver`) is pinged, any other is asked for the latest checkpoint of a thread that
 * does not exist — one read, nothing written.
 */
export async function pingCheckpointSaver(saver: BaseCheckpointSaver): Promise<void> {
  const ping: unknown = Reflect.get(saver, "ping");
  if (typeof ping === "function") {
    const pinged: unknown = Reflect.apply(ping, saver, []);
    await pinged;
    return;
  }
  await saver.getTuple(PROBE_THREAD);
}

/** The stores of the instance, each with its ping: the #265 contracts and the checkpoint saver. */
function storesOf(sources: HealthSources): readonly [object, () => Promise<void>][] {
  const { infrastructure: stores } = sources;
  // the listed saver, under the ordered checkpointer the instance reads through (#682)
  const { checkpointer } = stores;
  const saver = checkpointer instanceof OrderedCheckpointSaver ? checkpointer.saver : checkpointer;
  return [
    [stores.records, () => stores.records.ping()],
    [stores.costLedger, () => stores.costLedger.ping()],
    [stores.pausedExecutions, () => stores.pausedExecutions.ping()],
    [stores.executionLeases, () => stores.executionLeases.ping()],
    [stores.executionTrees, () => stores.executionTrees.ping()],
    [stores.rateLimits, () => stores.rateLimits.ping()],
    [stores.meshRequests, () => stores.meshRequests.ping()],
    [stores.executionHistory, () => stores.executionHistory.ping()],
    [stores.leaseEvents, () => stores.leaseEvents.ping()],
    [saver, () => pingCheckpointSaver(saver)],
  ];
}

const storeProbes = (sources: HealthSources): Promise<HealthComponentReport>[] =>
  storesOf(sources).map(([store, ping]) =>
    probe(
      { name: store.constructor.name, kind: HealthComponentKind.Store, timeout: STORE_TIMEOUT },
      sources.infrastructure.clock,
      async () => {
        await ping();
        return HEALTHY;
      },
    ),
  );

/** A provider's breaker: open (a pause under its key) → `Degraded` until it closes by itself. */
const providerProbes = (sources: HealthSources): Promise<HealthComponentReport>[] =>
  sources.modelProviders.map((provider) => {
    const { name } = modelProviderOf(provider);
    const component = { name, kind: HealthComponentKind.ModelProvider, timeout: STORE_TIMEOUT };
    return probe(component, sources.infrastructure.clock, async () => {
      const openUntil = await sources.infrastructure.rateLimits.pausedUntil(circuitOpenKeyOf(name));
      return openUntil === undefined
        ? HEALTHY
        : {
            status: HealthStatus.Degraded,
            reason: `circuit breaker open until ${openUntil.toISOString()}`,
          };
    });
  });

/** A project's check under its own `timeout`: its result as it is. */
const projectProbe = (
  sources: HealthSources,
  { meta, handler }: ProjectHealthCheck,
): Promise<HealthComponentReport> =>
  probe(
    { name: meta.name, kind: HealthComponentKind.Project, timeout: meta.timeout },
    sources.infrastructure.clock,
    async () => {
      const result = await handler.check();
      return result.status === HealthStatus.Healthy
        ? HEALTHY
        : { status: result.status, reason: result.reason };
    },
  );

/** `32 of 32 step slots busy, 7 steps waiting`: why a full instance is degraded. */
const busyReason = (busy: number, max: number, waiting: number): string =>
  `${String(busy)} of ${String(max)} step slots busy, ${String(waiting)} ${waiting === 1 ? "step" : "steps"} waiting`;

/**
 * The instance's step slots (#332): `Degraded` while none is free — a load balancer sends new work
 * elsewhere — `Healthy` again once one frees; no component when the application caps none. In
 * memory: it takes no time.
 */
function stepSlotsReports(sources: HealthSources): Promise<HealthComponentReport>[] {
  const slots = sources.stepSlots;
  if (slots === undefined) return [];
  const component = { name: "step-slots", kind: HealthComponentKind.StepSlots };
  const outcome: ProbeOutcome =
    slots.freeSlots() > 0
      ? HEALTHY
      : {
          status: HealthStatus.Degraded,
          reason: busyReason(slots.busySlots(), slots.maxConcurrentSteps, slots.waitingSteps()),
        };
  return [Promise.resolve(componentReportOf(component, outcome, waitOf(0)))];
}

/** Every readiness-only check, started now. */
export const readinessProbes = (sources: HealthSources): Promise<HealthComponentReport>[] => [
  ...stepSlotsReports(sources),
  ...storeProbes(sources),
  ...providerProbes(sources),
  ...sources.healthChecks.map((check) => projectProbe(sources, check)),
];
