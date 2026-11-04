# Metrics

An application instance publishes the numbers an autoscaler and an operator need — queued work, its
step slots, the tree leases it holds, takeovers, hand-overs, ended executions and undo actions —
through **OpenTelemetry metrics** (#485). The core ships no exporter and opens no port: the
application gives it a `MeterProvider`, and any OpenTelemetry exporter takes the numbers to
Prometheus (and so to KEDA or an HPA), AWS CloudWatch, Google Cloud Monitoring or Azure Monitor.
How to scale on them — the Prometheus recipe, KEDA, an HPA, ECS, Cloud Run, Container Apps: [Autoscaling](Autoscaling).

## Giving the app a meter

`createApp(App, { meterProvider })` — any `MeterProvider` of `@opentelemetry/api`: an SDK one with
the readers you want, or the global one (`metrics.getMeterProvider()`). The instance takes one meter
from it, named `@agboss/core` at the framework's version. No `meterProvider` → no metrics: nothing
is loaded and no store is read for them.

<!-- snippet-context
import { Application, EmptyEnvironment } from "@agboss/core";
@Application({ name: "desk-application", version: "1.0.0", environment: EmptyEnvironment, workflows: [] })
class DeskApplication {}
-->

```ts
import { createApp } from "@agboss/core";
import { MeterProvider, PeriodicExportingMetricReader, ConsoleMetricExporter } from "@opentelemetry/sdk-metrics";

const meterProvider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() })],
});
const app = await createApp(DeskApplication, { meterProvider });
```

At `app.close()` the instance removes its callbacks before its stores close (`onDestroy`): a scrape
of a stopping pod never reads a closed store. (The SDK may repeat a gauge's last value.)

## The metrics

The names, kinds, units and label keys are a contract (`src/metrics/metric-catalog.ts`, checked by
`tests/metrics/metric-catalog.test.ts`); a change is announced in the [Changelog](Changelog). The
Prometheus name is the official exporter's: `.` → `_`, a counter gets `_total`, a `{…}` unit is
dropped.

### Cluster — read from the shared store, the same on every instance

| Name (Prometheus) | Kind | Unit | Value |
| --- | --- | --- | --- |
| `agboss.cluster.children.queued` (`agboss_cluster_children_queued`) | gauge | `{execution}` | children launched with `ChildPlacement.AnyInstance` waiting to be claimed, every tenant and tree |
| `agboss.cluster.children.running` (`agboss_cluster_children_running`) | gauge | `{execution}` | those claimed by an instance |
| `agboss.cluster.children.oldest_queued_seconds` (`agboss_cluster_children_oldest_queued_seconds`) | gauge | `s` | how long the longest-waiting queued child has waited, on the app's `Clock`; `0` when none |

All three come from **one** call of `ChildExecutionQueueRepository.findQueueDepth()` per
collection — an aggregate, never a read per tree (the SQLite store: one statement over its claims
index). A read that fails reports none of the three for that collection — never a stale or zero
value — and the log warns `metrics.child-queue-unreadable` once per failure streak.

### Per instance — this pod's own numbers

| Name (Prometheus) | Kind | Unit | Labels | Value |
| --- | --- | --- | --- | --- |
| `agboss.instance.step_slots.limit` | gauge | `{slot}` | — | [`maxConcurrentSteps`](Several-instances#an-instances-cap-on-steps-332) |
| `agboss.instance.step_slots.busy` | gauge | `{slot}` | — | steps at work now |
| `agboss.instance.step_slots.free` | gauge | `{slot}` | — | `limit − busy` |
| `agboss.instance.steps.waiting` | gauge | `{step}` | — | steps waiting for a slot now |
| `agboss.instance.leases.held` | gauge | `{lease}` | — | tree leases it holds: roots it moves, children it claimed, a parent waiting for children (its lease yielded, still its own); a released or lost lease is not held |
| `agboss.instance.lease.takeovers` (`…_total`) | counter | `{takeover}` | `reason` | [takeovers](Observability#lease-takeovers-501) it made — recoveries are `reason="recovered"` (and `"unwinding"`) |
| `agboss.instance.steps.handed_over` (`…_total`) | counter | `{step}` | `reason` | [hand-overs](Observability#hand-overs-501) of its steps |
| `agboss.instance.executions.ended` (`…_total`) | counter | `{execution}` | `workflow`, `outcome` | executions that ended on it, children included: `finished` (`onExecutionEnd`), `failed` or `cancelled` (`onExecutionError`) |
| `agboss.instance.compensations` (`…_total`) | counter | `{action}` | `workflow`, `status` | [automatic undo actions](Observability#automatic-undo) that ended on it: `compensated` or `failed` |

The four slot gauges exist only when the application sets `maxConcurrentSteps`. Counters count
since the instance started.

**Labels are bounded by the code**: `reason` is a `LeaseTakeoverReason` or a `HandOverReason`,
`outcome` one of three, `status` a `CompensationStatus`, `workflow` one of the application's
workflow names. Never a tenant, an execution, a thread, an instance id or an error message — the pod
is the scrape target's own label (`pod`, `instance`) or the OTel resource's `service.instance.id`.
The counters come from a built-in observer the instance calls before the project's
[observers](Observability), on the event as it is (it reads enums and names only, so no PII mask
runs for it).

## Counting a cluster value once

Every instance reports the cluster gauges, each the value it read from the one shared store: with
three pods and twelve queued children, every pod reports `12`. **Aggregate cluster gauges with
`max` and per-instance ones with `sum`** — in a PromQL query, a KEDA trigger, a CloudWatch
statistic (`Maximum`), a Cloud Monitoring aligner (`ALIGN_MAX` / reducer `REDUCE_MAX`):

```promql
max(agboss_cluster_children_queued)            # 12 — never sum(...), which is 36
sum(agboss_instance_step_slots_busy)           # the steps at work over every pod
```

Why not one reporting pod: a "reporter" lease is one more lease to get right, a gap in the signal at
each failover, and a scrape of the wrong pod reads nothing. One indexed count per pod per scrape
interval is cheap.

## Scale signals

| Signal | Expression | Meaning |
| --- | --- | --- |
| **Demand** (scale out) | `max(agboss_cluster_children_queued) + sum(agboss_instance_steps_waiting) + sum(agboss_instance_step_slots_busy)` | the steps that want a slot now; target per pod = its `maxConcurrentSteps` |
| **Idle** (safe to scale in to a minimum of one or more) | `max(agboss_cluster_children_queued) + max(agboss_cluster_children_running) + sum(agboss_instance_leases_held) + sum(agboss_instance_step_slots_busy) + sum(agboss_instance_steps_waiting) == 0` | nothing queued, running, held or at work anywhere |

A parent waiting for its children holds its lease, and a claimed child between two steps holds its
lease: neither reads idle (`tests/metrics/scale-signals.test.ts` looks at every turn of a tree and
never sees idle before its end). Roots arrive through your own endpoints, not a queue: they count
through their slots and leases once they run. A scale-in still removes a pod that may hold work —
its graceful stop (`app.close({ timeout })` within the pod's termination grace) and the
[recovery](Several-instances#recovery) of what it hands over are what make that safe —
[Autoscaling → Graceful termination](Autoscaling#graceful-termination).
That recovery is a live pod's sweep: a root handed over, or left by a crash, is on no gauge until a
sweep takes it, so idle may read true in that window (#751,
[`hand-over-window.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/metrics/hand-over-window.test.ts)) —
never scale to zero on it.

## Testing

`testWith(App, { meterProviders: [a, b] })` gives each instance its own provider, by instance (a
missing one = no metrics there); read it with an in-memory reader:

<!-- snippet-context
import { Application, EmptyEnvironment } from "@agboss/core";
@Application({ name: "desk-application", version: "1.0.0", environment: EmptyEnvironment, workflows: [] })
class DeskApplication {}
-->

```ts
import { expect } from "vitest";
import { testWith } from "@agboss/core/testing";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";

class InMemoryReader extends MetricReader {
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const reader = new InMemoryReader();
const test = testWith(DeskApplication, {
  meterProviders: [new MeterProvider({ readers: [reader] })],
});

test("an idle instance holds no lease", async ({ app }) => {
  await app.ready();
  const { resourceMetrics } = await reader.collect();
  const held = resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.descriptor.name === "agboss.instance.leases.held");
  expect(held?.dataPoints[0]?.value).toBe(0);
});
```

## Your own store

Every `ChildExecutionQueueRepository` answers `findQueueDepth(): Promise<ChildExecutionQueueDepth>`
— `{ queued, running, oldestQueuedAt? }` over every tenant and tree, in one round trip. The queue
contract (`childExecutionQueueContract`, and so `storeConformance`) checks it: empty, rows of
several tenants and trees by status, the oldest *still queued* (a claim of the oldest moves it),
both instances read the same, a tree's rows gone with its root, a lost claim queued again, forty
rows claimed by two instances at once counted once. [Your own store](Your-own-store).
