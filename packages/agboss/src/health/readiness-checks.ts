import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { Class } from "../components/injection.js";
import { classOf, type AssembledStorage } from "../storage/storage-assembly.js";
import { storageDriverOf } from "../storage/storage-driver.js";
import { isInlineFileStore } from "../infrastructure/file.repository.js";
import { OrderedCheckpointSaver } from "../app/leased-checkpointer.js";
import { CircuitBreaker, circuitOpenKeyOf } from "../models/circuit-breaker.js";
import { modelProviderOf } from "../models/model-provider.decorator.js";
import { seconds, type Milliseconds } from "../units/index.js";
import { probe, type ProbeOutcome } from "./health-probe.js";
import { HealthComponentKind, HealthStatus, type HealthComponentReport } from "./health-check.js";
import type { HealthSources, ProjectHealthCheck } from "./health-sources.js";

/**
 * What only readiness checks (#300): one `ping()` per storage component (#1321), every model provider's circuit
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

/** A store of the instance with the ping that reaches it. */
type Pinged = readonly [store: object, ping: () => Promise<void>];

/** The checkpoint saver's own `ping()`; a saver without one is not probed (LangGraph's contract has none). */
const saverPingOf = (saver: BaseCheckpointSaver): (() => Promise<void>) | undefined => {
  const ping: unknown = Reflect.get(saver, "ping");
  return typeof ping === "function"
    ? async () => {
        await Reflect.apply(ping, saver, []);
      }
    : undefined;
};

/** The stores of the instance, each with its ping: the #265 contracts and the checkpoint saver. */
function storesOf(sources: HealthSources): readonly Pinged[] {
  const { infrastructure: stores } = sources;
  // the listed saver, under the ordered checkpointer the instance reads through (#682)
  const { checkpointer } = stores;
  const saver = checkpointer instanceof OrderedCheckpointSaver ? checkpointer.saver : checkpointer;
  const saverPing = saverPingOf(saver);
  return [
    [stores.records, () => stores.records.ping()],
    [stores.costLedger, () => stores.costLedger.ping()],
    [stores.pausedExecutions, () => stores.pausedExecutions.ping()],
    [stores.executionLeases, () => stores.executionLeases.ping()],
    [stores.executionTrees, () => stores.executionTrees.ping()],
    [stores.rateLimits, () => stores.rateLimits.ping()],
    [stores.meshRequests, () => stores.meshRequests.ping()],
    [stores.a2aTasks, () => stores.a2aTasks.ping()],
    // #859: the default keeps no file (they ride inline): nothing to reach
    ...(isInlineFileStore(stores.a2aFiles)
      ? []
      : [[stores.a2aFiles, () => stores.a2aFiles.ping()] satisfies Pinged]),
    [stores.a2aDirectMessages, () => stores.a2aDirectMessages.ping()],
    [stores.executionHistory, () => stores.executionHistory.ping()],
    [stores.auditLog, () => stores.auditLog.ping()],
    ...(saverPing === undefined ? [] : [[saver, saverPing] satisfies Pinged]),
  ];
}

/** One probe: the component's name and the ping that reaches it. */
interface StorageProbe {
  readonly name: string;
  readonly ping: () => Promise<void>;
}

/** Every storage component of the application (`@DatabaseStorage`, `@ClusterStorage`, `@ObjectStorage`) with the classes its driver creates. */
function storageComponentsOf(
  storage: AssembledStorage | undefined,
): readonly { readonly name: string; readonly classes: readonly Class[] }[] {
  const entries = [storage?.database, storage?.cluster, storage?.objects];
  return entries.flatMap((entry) => {
    const driver = storageDriverOf(entry?.meta.driver);
    return entry === undefined || driver === undefined
      ? []
      : [{ name: entry.meta.name, classes: driver.providers.flatMap((one) => classOf(one) ?? []) }];
  });
}

/**
 * One ping per storage component (#1321): the stores a component's driver creates share its
 * connection, so the first of them reaches it for all and the component is reported under its own
 * name. A store the application replaced or brought itself (no driver created it) is its own probe.
 */
function storageProbesOf(sources: HealthSources): readonly StorageProbe[] {
  const components = storageComponentsOf(sources.storage);
  const probes: StorageProbe[] = [];
  const pinged = new Set<string>();
  for (const [store, ping] of storesOf(sources)) {
    const component = components.find(({ classes }) => classes.some((cls) => store instanceof cls));
    if (component === undefined) {
      probes.push({ name: store.constructor.name, ping });
    } else if (!pinged.has(component.name)) {
      pinged.add(component.name);
      probes.push({ name: component.name, ping });
    }
  }
  return probes;
}

const storeProbes = (sources: HealthSources): Promise<HealthComponentReport>[] =>
  storageProbesOf(sources).map(({ name, ping }) =>
    probe(
      { name, kind: HealthComponentKind.Storage, timeout: STORE_TIMEOUT },
      sources.infrastructure.clock,
      async () => {
        await ping();
        return HEALTHY;
      },
    ),
  );

/**
 * A provider's breaker, as `RateLimitRepository` keeps it: open or half-open (probing) → `Degraded`
 * until it closes — never `Unhealthy`: the instance stays in rotation while its fallback serves.
 */
const providerProbes = (sources: HealthSources): Promise<HealthComponentReport>[] =>
  sources.modelProviders.map((provider) => {
    const { name, circuitBreakerPolicy } = modelProviderOf(provider);
    const component = { name, kind: HealthComponentKind.ModelProvider, timeout: STORE_TIMEOUT };
    return probe(component, sources.infrastructure.clock, async () => {
      if (circuitBreakerPolicy === undefined) return HEALTHY;
      const { rateLimits, clock } = sources.infrastructure;
      const openUntil = await rateLimits.pausedUntil(circuitOpenKeyOf(name));
      if (openUntil !== undefined) {
        return {
          status: HealthStatus.Degraded,
          reason: `circuit breaker open until ${openUntil.toISOString()}`,
        };
      }
      const breaker = new CircuitBreaker(name, circuitBreakerPolicy, { rateLimits, clock });
      return (await breaker.state()) === "closed"
        ? HEALTHY
        : {
            status: HealthStatus.Degraded,
            reason: "circuit breaker half-open: probing the provider",
          };
    });
  });

/** A project's check under its own `timeout`: its result as it is. */
const projectProbe = (
  sources: HealthSources,
  { meta, handler }: ProjectHealthCheck,
): Promise<HealthComponentReport> =>
  probe(
    { name: meta.name, kind: HealthComponentKind.HealthCheck, timeout: meta.timeout },
    sources.infrastructure.clock,
    async (signal) => {
      const result = await handler.check({ signal });
      return result.status === HealthStatus.Healthy
        ? HEALTHY
        : { status: result.status, reason: result.reason };
    },
  );

/** Every readiness-only check, started now. */
export const readinessProbes = (sources: HealthSources): Promise<HealthComponentReport>[] => [
  ...storeProbes(sources),
  ...providerProbes(sources),
  ...sources.healthChecks.map((check) => projectProbe(sources, check)),
];
