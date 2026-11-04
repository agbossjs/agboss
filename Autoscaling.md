# Autoscaling

How to scale AGBoss workers on their real queued work (#486): the core's
[OpenTelemetry metrics](Metrics) through the **official** exporter — no AGBoss package in between —,
then KEDA or an HPA on Kubernetes, or the platform's own rule on ECS, Cloud Run and Container Apps
through the OpenTelemetry Collector. Every file below is in
[`14-kubernetes-postgres-scaling`](https://github.com/agbossjs/agboss-examples/tree/main/14-kubernetes-postgres-scaling)
of agbossjs/agboss-examples, validated by kubeconform (the example's `check:k8s` script); the cluster run of the
whole cycle is #487.

## The recipe: Prometheus

```ts no-check: needs @opentelemetry/exporter-prometheus, the project's own dependency
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { createApp } from "@agboss/core";

const exporter = new PrometheusExporter({ port: 9464 }); // GET :9464/metrics
const meterProvider = new MeterProvider({
  resource: resourceFromAttributes({ "service.name": "agboss-worker" }),
  readers: [exporter],
});
const app = await createApp(WorkerApplication, { meterProvider });
// at the very end of the process: await meterProvider.shutdown()
```

The versions the example pins: `@opentelemetry/exporter-prometheus@0.222.0`,
`@opentelemetry/sdk-metrics@2.11.0`, `@opentelemetry/resources@2.11.0` (the 2.x line, which works
with the core's `@opentelemetry/api@^1.9`; the 0.300 / 3.x line needs api 1.10). A scrape returns
the names of [Metrics](Metrics) in Prometheus form — `agboss_cluster_children_queued`,
`agboss_instance_step_slots_busy`, `agboss_instance_executions_ended_total{workflow,outcome}`, … —
proven by the example's `tests/telemetry/prometheus-scrape.test.ts`.

## Which metric drives what, and why

| Signal | Query | Why |
| --- | --- | --- |
| **Scale out — slot demand** | `max(agboss_cluster_children_queued) + sum(agboss_instance_steps_waiting) + sum(agboss_instance_step_slots_busy)` | every step that wants a step slot now: children queued for any worker, steps waiting for a slot on their pod, steps at work. Target per pod = its `maxConcurrentSteps` → replicas = ⌈demand / slots⌉ |
| **Scale in** | the same demand falling, held for a stabilization window (300 s), one pod a minute | queued work arrives in waves; a short lull must not remove pods about to be needed |
| **Idle — the floor** | `max(agboss_cluster_children_queued) + max(agboss_cluster_children_running) + sum(agboss_instance_leases_held) + sum(agboss_instance_step_slots_busy) + sum(agboss_instance_steps_waiting) == 0` | nothing queued, running or held anywhere — but not work waiting for recovery: see below (#751) |

`agboss_cluster_*` comes from the shared store and every pod reports the same value: **`max`,
never `sum`**. The pod-level series sum. Roots arrive through your own endpoint (a Service balances
them), not through a queue: they count once they run, through their slots and leases.

**What idle does not see (#751).** A root handed over by a stop (a scale-in's SIGTERM past
`shutdownTimeout`), or left by a crash, is on no gauge until another pod's recovery sweep takes it:
its record is `running`, but its lease is released (or expired) and none of its steps is at work.
Idle reads true in that window, for up to one sweep (30 s) after a hand-over and the lease (30 s)
plus a sweep after a crash. It is only the live pods' sweeps that continue such a root, so keep
`minReplicaCount ≥ 1`. Scale to zero only if a root stranded until the next pod starts is
acceptable.

## KEDA (recommended)

KEDA reads Prometheus itself — no adapter to run — and can scale to zero. `deploy/keda-scaledobject.yaml`:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: agboss-worker }
spec:
  scaleTargetRef: { name: agboss-worker }
  minReplicaCount: 1
  maxReplicaCount: 10
  cooldownPeriod: 300
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp: { stabilizationWindowSeconds: 0, policies: [{ type: Percent, value: 100, periodSeconds: 15 }] }
        scaleDown: { stabilizationWindowSeconds: 300, policies: [{ type: Pods, value: 1, periodSeconds: 60 }] }
  triggers:
    - type: prometheus
      metricType: AverageValue
      metadata:
        serverAddress: http://prometheus-server.monitoring.svc:80
        query: >-
          max(agboss_cluster_children_queued) + sum(agboss_instance_steps_waiting) + sum(agboss_instance_step_slots_busy)
        threshold: "4" # = maxConcurrentSteps
        activationThreshold: "0"
```

With `minReplicaCount: 0`, KEDA wakes the Deployment when the demand passes `activationThreshold`
— but the demand is reported by the pods, so with none running nothing wakes it; a root arriving
through your Service needs a pod first, and a root handed over or left by a crash waits for one
(#751): keep 1. [KEDA Prometheus scaler](https://keda.sh/docs/latest/scalers/prometheus/) ·
[ScaledObject spec](https://keda.sh/docs/latest/reference/scaledobject-spec/).

## An HPA through prometheus-adapter

`deploy/prometheus-adapter-values.yaml` turns the same query into the external metric
`agboss_slot_demand`; `deploy/hpa-prometheus-adapter.yaml` is an `autoscaling/v2` HPA with an
`External` metric, `AverageValue: "4"` and the same `behavior`. Use KEDA or the HPA, not both: two
controllers on one Deployment fight. [prometheus-adapter](https://github.com/kubernetes-sigs/prometheus-adapter) ·
[HPA walkthrough](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/).

## Graceful termination

A scale-in sends SIGTERM to a pod the controller chose — not necessarily an idle one. What makes it
safe is the stop (#265, #367), not the choice:

1. `preStop: sleep 5` — endpoints and load balancers drop the pod while it still serves.
2. SIGTERM → `createApp`'s listener calls `app.close()`: readiness turns `Unhealthy`, no new
   execution is accepted, running steps get `shutdownTimeout` (`@Application({ shutdownTimeout })`,
   `app.close({ timeout })`; the example's 30 s) to end or pause.
3. Whatever still runs is interrupted and **handed over**: its record stays `running`, its lease is
   released, another pod's recovery sweep continues it from its last checkpoint
   ([Several instances → Recovery](Several-instances#recovery)); a child it claimed stays `Running`
   in the queue and a live worker reclaims it once its lease is free.
4. `terminationGracePeriodSeconds` (45) > preStop (5) + `shutdownTimeout` (30) + a margin. A SIGKILL
   before the stop ends is a crash: still recovered, but only once the lease expires (30 s) and with
   the step run again — idempotency of external effects is the fenced effect's and the outbound
   call's ([Guarantees](Guarantees)), not the autoscaler's.

The full operator's guide — every failure and who handles it, the production settings, and the
checklists for ECS, Cloud Run, Container Apps and Nomad: [Deploying on Kubernetes](Deploying-on-Kubernetes).
Try the whole cycle on kind: agbossjs/agboss-examples `14-kubernetes-postgres-scaling`
(its `cluster:up` and `cluster:scenario` scripts, #487).

## Other platforms: the OpenTelemetry Collector

The same metrics, scraped by a Collector sidecar from `localhost:9464` and written to the platform's
monitoring; the platform's own rule scales on the slot demand. The files are in
`deploy/collector/`.

### Amazon ECS — CloudWatch

The AWS Distro for OpenTelemetry Collector (`prometheus` receiver → `awsemf` exporter, namespace
`AGBoss`, no per-task dimension, a 60 s scrape) and a **target-tracking** policy on **metric math**:
`(Maximum(queued) + Sum(waiting) + Sum(busy)) / RunningTaskCount`, target 4
(`ecs-cloudwatch.yaml`, `ecs-scaling-policy.json`). With one scrape per period, a period's
`Maximum` is the cluster value and its `Sum` the tasks' total.
[ADOT CloudWatch metrics](https://aws-otel.github.io/docs/getting-started/cloudwatch-metrics) ·
[ADOT on ECS](https://aws-otel.github.io/docs/setup/ecs) ·
[ECS target tracking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-targettracking.html) ·
[custom metrics with metric math](https://aws.amazon.com/blogs/containers/autoscaling-amazon-ecs-services-based-on-custom-metrics-with-application-auto-scaling/).

### Google Cloud Run — Cloud Monitoring

The Collector sidecar → `googlemanagedprometheus` (`cloudrun-gmp.yaml`). Plainly: a Cloud Run
**service** scales on requests and CPU, never on a custom metric. Run the workers as a Cloud Run
**worker pool** and scale it with **CREMA** (Cloud Run External Metrics Autoscaling: KEDA's scalers
in a Cloud Run service) — the file's `CremaConfig` uses KEDA's `prometheus` trigger against Managed
Prometheus' query API. Google lists Kafka, Cron and Pub/Sub as its verified CREMA scalers: verify the
Prometheus one in your project first.
[OpenTelemetry sidecar on Cloud Run](https://cloud.google.com/run/docs/tutorials/custom-metrics-opentelemetry-sidecar) ·
[worker pools with external metrics](https://cloud.google.com/run/docs/configuring/workerpools/crema-autoscaling) ·
[CREMA](https://github.com/GoogleCloudPlatform/cloud-run-external-metrics-autoscaling) ·
[Managed Prometheus query API](https://cloud.google.com/stackdriver/docs/managed-prometheus/query-api-ui).

### Azure Container Apps — KEDA

Container Apps runs KEDA itself. The Collector sidecar remote-writes to Azure Monitor managed
Prometheus with the app's managed identity; a **custom scale rule** of type `prometheus` queries the
workspace with the same slot demand, threshold 4 (`containerapps-keda.yaml`).
[Container Apps scale rules](https://learn.microsoft.com/azure/container-apps/scale-app) ·
[KEDA Prometheus scaler](https://keda.sh/docs/latest/scalers/prometheus/) ·
[remote write with a managed identity](https://learn.microsoft.com/azure/azure-monitor/containers/prometheus-remote-write-managed-identity) ·
[PromQL against an Azure Monitor workspace](https://learn.microsoft.com/azure/azure-monitor/metrics/prometheus-api-promql).

## What AGBoss does not do

No operator, no scheduler, no pod created or deleted by AGBoss, no replacement for KEDA or the HPA:
it publishes honest numbers and stops gracefully; the platform decides.
