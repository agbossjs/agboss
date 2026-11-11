# Deploying on Kubernetes

What AGBoss needs from the platform it runs on, what it does on each failure, what is left to
Kubernetes, PostgreSQL and the application, and the settings each platform needs — Kubernetes first,
then the platforms that run long-lived containers the same way (Amazon ECS, Google Cloud Run, Azure
Container Apps, HashiCorp Nomad, Fly.io, Railway, Render, plain VMs). Every guarantee named here is a
row of [Guarantees](Guarantees) and links the test that proves it; every platform limit cites the
platform's own documentation, read on 2026-11-02.

The worked deployment is agbossjs/agboss-examples
[`14-kubernetes-postgres-scaling`](https://github.com/agbossjs/agboss-examples/tree/main/14-kubernetes-postgres-scaling)
(#487): kind, PostgreSQL, KEDA, a backlog, a killed and a frozen worker, scale-in — verified from the
stores' state. The pages it builds on: [Several instances](Several-instances),
[Running on PostgreSQL](Running-on-PostgreSQL), [Metrics](Metrics), [Autoscaling](Autoscaling),
[Health checks](Health-checks), [Guarantees across processes](Guarantees-across-processes).

## What AGBoss needs from any platform

| # | Requirement | Why | The setting |
| --- | --- | --- | --- |
| **R1** | **A long-lived process with CPU between requests** | An instance renews each lease it holds every 10 s (a 30 s lease, not a setting), sweeps for orphaned trees every 30 s, and claims queued children while it has a free step slot. With no CPU outside a request none of that runs: its leases expire under it and nothing it queued is picked up. | Kubernetes: any Deployment. Cloud Run: instance-based billing. Lambda: impossible (below). |
| **R2** | **One shared transactional store per application, no shared disk** | Every instance reads and writes the same leases, trees, child queue, checkpoints and fenced effects; a fencing store checks its lease in its own transaction, so it lives in the lease store's database ([Guarantees](Guarantees) A2). SQLite on a `ReadWriteMany` volume, an NFS lock, or a file per pod is not a shared store. | `@agboss/postgres` ([Running on PostgreSQL](Running-on-PostgreSQL)), or MongoDB ([MongoDB](MongoDB)). |
| **R3** | **A SIGTERM grace of at least preStop + `shutdownTimeout` + a margin** | On SIGTERM `createApp` closes the app: readiness turns `Unhealthy`, running steps get `shutdownTimeout`, what still runs is handed over. A SIGKILL inside that window is a crash: recovered, but only after the lease expires, with the step run again. | `terminationGracePeriodSeconds`, ECS `stopTimeout`, Nomad `kill_timeout`, … ([the platforms](#kubernetes-like-platforms)). |
| **R4** | **Probes on `app.checkLiveness()` and `app.checkReadiness()`** | Readiness takes a stopping pod (and one whose stores do not answer) out of the endpoints — a pod with every step slot busy is `Degraded`, still ready; liveness restarts a dead one. Liveness must outlast a short freeze: the lease keeps correctness while a pod is frozen, and a restart turns every GC pause into a crash. | `/health/live`, `/health/ready` ([Health checks](Health-checks)). |
| **R5** | **The database's clock slewed, never stepped; the hosts' clocks synchronized** | A lease's expiry is the database's time ([Guarantees](Guarantees) A3); a holder's fence counts on its own monotonic and wall clocks, within 1 s per 30 s of drift (A4). | NTP / chrony slewing on the database host (no `makestep` after start-up); the platform's time service. |
| **R6** | **A connection budget** | Each instance opens one pool. Pods × `postgresPoolSize` + the migration Job + a margin must stay under the database's `max_connections`, at the autoscaler's maximum. | `postgresPoolSize`, `maxReplicaCount`. |
| **R7** | **Optional: autoscaling on queued work** | The scale signal is the core's slot demand, the cluster gauges with `max`, the instance gauges with `sum` ([Metrics](Metrics), [Autoscaling](Autoscaling)). | KEDA, an HPA on prometheus-adapter, or the platform's own autoscaler on the same metric. |

## What happens on each failure, and who handles it

| Failure | What AGBoss does | What the platform must do | What PostgreSQL must do | What the application must do | Proved by |
| --- | --- | --- | --- | --- | --- |
| **SIGTERM** (scale-in, rollout, node drain) | readiness `Unhealthy`; no new execution; running steps get `shutdownTimeout`; what still runs is handed over (record stays `running`, lease released) and another pod continues it from its last checkpoint | send SIGTERM to the process, wait the grace (R3), take the pod out of the endpoints | — | nothing | [scenarios](#proofs) 1, 1b, 6, 11; #487 scale-in |
| **SIGKILL, OOM kill, node lost** | nothing in the dead pod; its lease expires after ≤ 30 s, another pod's sweep (≤ 30 s) or a worker's reclaim takes the tree over at a higher token and runs the interrupted step again | replace the pod (a Deployment does) | keep what was committed | make each external effect a fenced effect or an outbound call, so the step run again replays it | [scenarios](#proofs) 2, 3, 3b; #487 "AC3 a killed worker" |
| **A frozen pod** (GC pause, SIGSTOP, a VM paused) | its lease expires and another pod takes the tree over; when the pod resumes, its fence has expired: a step past its last check that reaches a fenced write is **refused** (`ExecutionFencedError`) and hands over | liveness tolerant of the freeze (R4) | the lease check inside the write's transaction | the same: writes inside the fenced effect | [scenarios](#proofs) 5, 5b, 5c, 5d, 12b, 13; #487 "AC5 zombie cannot write" |
| **A network partition** (the pod loses the database) | renewals fail; at its last confirmed renewal + 30 s − 1 s the pod stops its steps and writes nothing; another pod takes the trees over; when the database comes back the old pass does not continue | — | — | — | [scenarios](#proofs) 4, 8, 8b |
| **A database outage** (all pods) | every pod stops its trees at its fence; readiness `Unhealthy` (the stores' `ping`); when the database is back, the sweep takes every orphaned tree over at a new token | keep the pods (liveness does not depend on the database) | durability of what was committed; one primary; its clock (R5) | — | [scenario](#proofs) 8b; [Running on PostgreSQL → What the guarantees assume](Running-on-PostgreSQL#what-the-guarantees-assume-of-postgresql) |
| **A crash after an external effect, before the checkpoint** | the new holder runs the step again; a fenced effect returns its stored result (`Replayed`), an outbound call reconciles its pending intent with the other system and resends only when it never arrived | — | — | an other system that deduplicates on `call.idempotencyKey` and can be asked what happened ([Payment gateways](Payment-gateways) G1–G6) | [scenarios](#proofs) 3, 3b, 9, 10; #487 "AC5 the replayed effect applied once" |
| **A real failure of a step** (an error, not a hand-over) | the step fails; declared undos run, once, and only for a real failure — never because a lease was handed over | — | — | declare `compensateWith` for what must be undone | [scenarios](#proofs) 12, 12b |

### Compensation is not crash recovery

A **crash** (SIGKILL, a frozen pod, a lost database) never undoes anything: the tree is taken over
and the interrupted step runs again — its fenced effects replay, its outbound calls reconcile. An
**undo** runs only when a step really failed or the execution was cancelled, and once it is marked
done it never runs again on any instance ([Guarantees](Guarantees) P5, scenarios 12 and 12b). The
two are separate mechanisms: an application whose external effect is not fenced is not made safe by
declaring an undo for it ([Rollback](Rollback), [Cancellation and idempotency](Saga-And-Cancellation)).

## Who guarantees what

**AGBoss** (each with its assumptions: [Guarantees](Guarantees)):

- **P1 — one owner per tree**: at any moment at most one instance trusts a tree's lease, and no write
  is accepted under a superseded, released, finished or expired token;
- **P2 — one effect per business key**: a fenced effect runs its write once per step or business key;
- **P3 — one send per attempt**: an outbound call sends only after it claimed the attempt, while its lease holds;
- **P4 — no takeover of finished work**;
- **P5 — compensation only on real failure, once**.

**Kubernetes** (or the platform): run the process with CPU (R1); deliver SIGTERM and wait the grace
(R3); probe and restart (R4); replace a dead pod; schedule a new one when the autoscaler asks; route
only to ready pods; keep the hosts' clocks synchronized.

**PostgreSQL**: durability of what it acknowledged; one primary at a time; its clock slewed, never
stepped — a failover to a host whose clock differs is a step ([Guarantees](Guarantees) A3); enough
connections (R6). The stores' contracts and fault suite on PostgreSQL are agbossjs/postgres's CI.

**The application**: every write that must happen once inside a fenced effect, in the store's own
database ([Several instances → The fenced effect](Several-instances#the-fenced-effect-500)); every
call to another system through `OutboundCalls`, keyed by a business key, with a `reconcile`
([Payments](Payments)); the other system deduplicating on the key; one idempotency key (`idempotencyKeyField`, #825) shared by every
pod ([Guarantees](Guarantees) A8).

## Kubernetes

The settings #487 runs, and why each value.

```yaml
spec:
  terminationGracePeriodSeconds: 45 # > preStop 5 + shutdownTimeout 30 + margin (R3)
  containers:
    - name: worker
      resources:
        requests: { cpu: 200m, memory: 192Mi }
        limits: { cpu: 500m, memory: 256Mi }
      readinessProbe:
        httpGet: { path: /health/ready, port: http }
        periodSeconds: 5
        failureThreshold: 2 # out of the endpoints within 10 s of a stop or a freeze
      livenessProbe:
        httpGet: { path: /health/live, port: http }
        periodSeconds: 10
        timeoutSeconds: 2
        failureThreshold: 9 # 90 s: longer than a takeover (30 s lease + 30 s sweep)
      lifecycle:
        preStop:
          exec: { command: ["sleep", "5"] } # endpoints drop the pod before the app stops taking work
```

- **The stores**: every store of `@agboss/postgres`, migrated by a Job before the pods start
  (`agboss-postgres migrate`), never on start from several pods at once
  ([Running on PostgreSQL → Migrations](Running-on-PostgreSQL#migrations)).
- **PID 1**: run node under an init (`tini`) or make sure node is PID 1 and handles SIGTERM — it does
  (`createApp` listens). An init also lets `kubectl exec … kill` reach node, which a PID 1 of a
  namespace ignores.
- **`maxConcurrentSteps`** is the pod's capacity, the autoscaler's target per pod (4 in #487). Size
  it to the pod's CPU and memory requests for the steps the application runs; a step waiting on a
  model or an API takes a slot but little CPU.
- **Autoscaling**: KEDA on the slot demand, `threshold` = `maxConcurrentSteps`; scale-in stabilized
  (300 s in production) and one pod at a time ([Autoscaling](Autoscaling)). To stop the autoscaler
  for maintenance, annotate the ScaledObject `autoscaling.keda.sh/paused-replicas: "<n>"`
  ([KEDA: pausing autoscaling](https://keda.sh/docs/latest/concepts/scaling-deployments/)).
- **A `PodDisruptionBudget`** with `maxUnavailable: 1` makes a node drain stop one pod at a time —
  each a SIGTERM with its grace, each recovered.
- **The pool**: `postgresPoolSize` × the autoscaler's maximum + the coordinator + the Job, under
  `max_connections` (R6).
- **Kubernetes' own termination**: SIGTERM to PID 1 after the preStop hook; the grace counts from the
  start of the preStop; SIGKILL when it ends (the default grace is 30 s, too short for the default
  `shutdownTimeout` of 25 s plus a preStop)
  ([Pod lifecycle → Termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/),
  [Probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)).
- **EKS, AKS, k3s**: as above. **GKE Autopilot** caps `terminationGracePeriodSeconds` at 600 s, and
  at 15 s for a Spot Pod preempted (25 s during an upgrade drain): on Spot set `shutdownTimeout`
  below 10 s and treat a preemption as scenario 11
  ([Autopilot Spot Pods](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/autopilot-spot-pods),
  [Autopilot upgrades](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cluster-upgrades-autopilot)).

### An example run on kind

The blueprint [`14-kubernetes-postgres-scaling`](https://github.com/agbossjs/agboss-examples/tree/main/14-kubernetes-postgres-scaling)
runs this whole cycle on kind with its scripts `cluster:up` and `cluster:scenario`.
One recorded run (2026-11-04, the node capped at 3 CPU / 4 GB, `@agboss/core` `06c4bc1d`,
`@agboss/postgres` `3109b8c8`) passed its 15 checks in 290 s:

- **Scale-out**: 80 queued jobs took the workers from 1 to 4 in 25 s, through KEDA on the slot demand.
- **Kill** (`kill -9`, the pod deleted): its 4 leases were taken over by the other pods.
- **Freeze** (`SIGSTOP`): another pod took its job over at token 2 after 34 s. Back (`SIGCONT`),
  its write at token 1 was refused, and it was not restarted (liveness 10 s × 9). A zombie may
  instead stop at its own lease's end before it writes: no write at its token either way, the
  store's refusal being the backstop for the window its own fence does not see.
- **Kill before the write** (exit 137): never attempted. **Crash after the write**: replayed, one
  ledger entry.
- **Scale-in**: 3 workers to 1, 61 s after the demand fell to 0 (stabilization 30 s here).
- **The verification, from state**: 131 jobs, 0 duplicates, 0 inconsistent; the refusal, the replay and
  the never-attempted write each where expected.

The node stayed under 16 % of its CPU and 1.5 GiB with four workers. The blueprint's README has
the run step by step.

## Recommended production settings

| Setting | Value | Why |
| --- | --- | --- |
| The execution lease | 30 s, renewed every 10 s — fixed, not a setting | two renewals may fail before it expires |
| `@Application({ shutdownTimeout })` | 25 s (the default) to 30 s; below the platform's grace less the preStop | R3 |
| `terminationGracePeriodSeconds` | preStop + `shutdownTimeout` + 10 s (45 s for 5 + 30) | R3 |
| Readiness | every 5 s, 2 failures | a stopping pod leaves the endpoints within 10 s |
| Liveness | every 10 s, timeout 2 s, ≥ 7 failures (≥ 70 s) | R4: longer than a takeover |
| `maxConcurrentSteps` | the pod's capacity; the autoscaler's target per pod | [Autoscaling](Autoscaling) |
| `postgresPoolSize` | 5–10; pods × it < `max_connections` | R6 |
| `piiKeyField`, `idempotencyKeyField` | one `Secret` each, the same for every pod (#825: never one another, nor a provider's key) | [Guarantees](Guarantees) A8 |
| `retention.fencedEffects` | 24 h (the default); longer than any retry of a step | [Guarantees](Guarantees) A12 |
| `outboundCalls.attemptTimeout` | 2 min (the default); above the other system's own timeout | [Guarantees](Guarantees) A6 |
| `retention.auditLog` | 24 h (the default) | the audit log an operator and a verification read |
| `retention.executionRecords` | set, when anyone reads the history | `agboss records export` |
| Scale-in | stabilization 300 s, one pod per minute | a lull does not kill pods about to get work |

## Kubernetes-like platforms

The requirements are the same on every platform; what changes is where each one is set and what a
platform cannot give. Each limit below cites the platform's documentation (read 2026-11-02).

### Amazon ECS (Fargate or EC2)

- **Provides**: long-lived tasks (R1); SIGTERM then SIGKILL after the container's `stopTimeout`;
  container health checks and target-group health checks; Service Auto Scaling with target tracking
  on a custom CloudWatch metric, metric math included.
- **Checklist**:
  - `stopTimeout`: preStop-equivalent + `shutdownTimeout` + margin. On **Fargate** the default is
    30 s and the maximum **120 s** ("the max stop timeout value is 120 seconds"); on EC2 it falls
    back to the agent's `ECS_CONTAINER_STOP_TIMEOUT`, then 30 s
    ([ContainerDefinition](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html),
    [StopTask](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_StopTask.html)).
  - The container `healthCheck` on `/health/live` (interval 5–300 s, retries 1–10, `startPeriod`)
    ([task definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html));
    the ALB target group on `/health/ready`, and its deregistration delay (default **300 s**) brought
    down to the grace
    ([health checks](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html),
    [attributes](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html)).
  - Autoscaling: the slot demand through ADOT → CloudWatch EMF, target tracking with metric math
    ([metric math](https://docs.aws.amazon.com/autoscaling/application/userguide/application-auto-scaling-target-tracking-metric-math.html);
    the recipe: [Autoscaling → Amazon ECS](Autoscaling#amazon-ecs--cloudwatch)).
  - Clocks: Fargate reports its clock against the Amazon Time Sync Service
    (`ClockErrorBound`, `ClockSynchronizationStatus`,
    [task metadata v4](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-fargate-response.html)).
- **Holds**: P1–P5 with every requirement met. **Does not hold**: a `shutdownTimeout` above 120 s on
  Fargate (the task is killed mid-drain: scenario 11b — recovered, not drained).

### Google Cloud Run

- **Services** scale on requests and CPU: with **request-based billing** a service has CPU only while
  it handles a request ("CPU is only allocated during request processing"), so R1 fails — leases
  expire between requests and nothing queued is claimed. With **instance-based billing** (formerly
  "CPU always allocated") CPU is there for the instance's whole life
  ([billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings)).
- **SIGTERM grace: 10 s**, fixed, for services, worker pools and jobs
  ([container contract](https://docs.cloud.google.com/run/docs/container-contract)). So
  `shutdownTimeout` must stay **below 10 s** (scenario 11: the pod hands over and exits in time;
  11b shows what a longer one costs).
- **Scale-to-zero**: an idle instance may be shut down at any time, even one kept by `min-instances`;
  with zero instances nothing renews, sweeps or claims — an orphaned tree waits until an instance
  starts ([container contract](https://docs.cloud.google.com/run/docs/container-contract),
  [instance autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling)).
- **Worker pools** — "a Cloud Run resource specifically designed for performing continuous background
  work", **generally available since 2026-04-14**: CPU always allocated, no URL, no autoscaling of
  their own; scaled by hand or by CREMA (KEDA-based)
  ([worker pools](https://docs.cloud.google.com/run/docs/deploy-worker-pools),
  [release notes](https://docs.cloud.google.com/run/docs/release-notes),
  [manual scaling](https://docs.cloud.google.com/run/docs/configuring/workerpools/manual-scaling),
  [CREMA](https://docs.cloud.google.com/run/docs/configuring/workerpools/crema-autoscaling)).
- **Probes**: startup, liveness and readiness on HTTP
  ([health checks](https://docs.cloud.google.com/run/docs/configuring/healthchecks)).
- **Checklist**: workers as a **worker pool** (or a service with instance-based billing and
  `min-instances ≥ 1`); `shutdownTimeout` ≤ 8 s; liveness on `/health/live`; the batch API as a
  service that only starts executions; autoscaling of the pool through CREMA on the slot demand
  ([Autoscaling → Cloud Run](Autoscaling#google-cloud-run--cloud-monitoring)).
- **Holds**: P1–P5 on worker pools, and on services with instance-based billing and `min-instances ≥ 1`.
  **Does not hold**: a service on request-based billing or scaled to zero — leases expire between
  requests, recovery waits for traffic; a `shutdownTimeout` above 10 s — every scale-in is a crash.

### Azure Container Apps

- **Provides**: long-lived replicas; SIGTERM then SIGKILL after the termination grace (default 30 s,
  `terminationGracePeriodSeconds` in the template); startup, liveness and readiness probes on HTTP or
  TCP; built-in KEDA scale rules, including any ScaledObject-based KEDA scaler
  ([application lifecycle](https://learn.microsoft.com/en-us/azure/container-apps/application-lifecycle-management),
  [create or update](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/create-or-update),
  [health probes](https://learn.microsoft.com/en-us/azure/container-apps/health-probes),
  [scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app)).
- **Missing by default**: `minReplicas` is **0** — an app scales to zero, and one without ingress
  "has no way of starting back up" ([scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app)).
- **Checklist**: `minReplicas ≥ 1`; `terminationGracePeriodSeconds` ≥ preStop + `shutdownTimeout` +
  margin (its maximum is not stated in the documentation we read: keep the 45 s of #487); probes on
  `/health/live` and `/health/ready`; a custom `prometheus` scale rule on the slot demand
  ([Autoscaling → Container Apps](Autoscaling#azure-container-apps--keda)).
- **Holds**: P1–P5 with `minReplicas ≥ 1`. **Does not hold**: scale-to-zero (as on Cloud Run).

### HashiCorp Nomad

- **Provides**: long-lived tasks; `kill_signal` then SIGKILL after `kill_timeout`; `shutdown_delay`
  between deregistering the service and the signal (the preStop); service checks over HTTP and
  `check_restart`; the Nomad Autoscaler with its Prometheus APM plugin
  ([task](https://developer.hashicorp.com/nomad/docs/job-specification/task),
  [service](https://developer.hashicorp.com/nomad/docs/job-specification/service),
  [check_restart](https://developer.hashicorp.com/nomad/docs/job-specification/check_restart),
  [Prometheus APM](https://developer.hashicorp.com/nomad/tools/autoscaling/plugins/apm/prometheus)).
- **Defaults to change**: `kill_timeout` is **5 s**, capped by the client's `max_kill_timeout`
  (default **30 s**); `kill_signal` is **SIGINT** for the exec, raw_exec and java drivers
  ([client](https://developer.hashicorp.com/nomad/docs/configuration/client)).
- **Checklist**: `kill_signal = "SIGTERM"` (AGBoss closes on SIGINT too, but say what you mean);
  `kill_timeout = "45s"` and the clients' `max_kill_timeout` raised above it; `shutdown_delay = "5s"`;
  an HTTP check on `/health/ready`, a `check_restart` with a `grace` and a `limit` wider than a takeover.
- **Holds**: P1–P5 with the timeouts raised. **Does not hold**: the defaults — a 5 s kill makes every
  stop a crash.

### Fly.io, Railway, Render, plain VMs

| Platform | The one setting it needs | Source |
| --- | --- | --- |
| **Fly.io** (Machines) | `kill_signal = "SIGTERM"` and `kill_timeout` ≥ `shutdownTimeout` + margin (default 5 s, max 300 s); `auto_stop_machines = "off"` or `min_machines_running ≥ 1` for workers | [fly.toml reference](https://docs.fly.io/reference/configuration) |
| **Railway** | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` ≥ `shutdownTimeout` + margin (the default is **0 s**: an immediate SIGKILL); serverless (sleeping) off for workers; its health check runs only at deploy, not continuously | [deployments](https://docs.railway.com/reference/deployments), [health checks](https://docs.railway.com/reference/healthchecks), [serverless](https://docs.railway.com/reference/app-sleeping) |
| **Render** | `maxShutdownDelaySeconds` ≥ `shutdownTimeout` + margin (default 30 s, max 300 s); workers as background workers | [deploys](https://render.com/docs/deploys), [background workers](https://render.com/docs/background-workers), [health checks](https://render.com/docs/health-checks) |
| **A VM** (systemd) | `TimeoutStopSec=` ≥ `shutdownTimeout` + margin (default 90 s), `KillSignal=SIGTERM` (the default); chrony slewing, no `makestep` beyond start-up | [systemd-system.conf](https://www.freedesktop.org/software/systemd/man/latest/systemd-system.conf.html), [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), [chrony.conf](https://chrony-project.org/doc/4.6/chrony.conf.html) |

### Not the runtime: AWS Lambda, Cloud Functions

A function is frozen when its handler returns ("After the invocation completes, the execution
environment is frozen") and its invocation is bounded (Lambda: at most 900 s; Cloud Run functions:
60 min for HTTP, 540 s for events)
([Lambda runtime environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html),
[Lambda timeout](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html),
[Cloud Run functions quotas](https://docs.cloud.google.com/functions/quotas)). Nothing renews a
lease between invocations, nothing sweeps, nothing claims queued children (R1): a tree started there
is a frozen pod by design. A function works only as a thin front: it starts an execution on a
worker's API (or writes a request the workers read) and returns. P1–P5 then hold on the workers;
none of them is a property of the function.

## Known limitations

- **The lease is not a setting** (30 s, renewed every 10 s): recovery after a crash takes up to the
  lease plus a sweep (≤ 60 s).
- **A pod frozen past its liveness window is restarted**: still correct (its leases were taken over),
  but its in-memory work is lost; size liveness above a takeover.
- **Scale-to-zero leaves orphaned trees unrecovered** until an instance starts.
- **Every instance claims children**: an instance cannot opt out (a "coordinator" claims too); the
  autoscaler's demand counts its slots.
- **A single database**: one primary at a time, its clock the leases' clock; a failover to a host
  whose clock differs is a step (A3).

## Proofs

The fault suite (#484, `faultSuite`) runs these scenarios on real processes — SIGTERM, SIGKILL,
SIGSTOP / SIGCONT, a cut database — in the core on SQLite
([`packages/agboss/tests/faults/`](https://github.com/agbossjs/agboss/tree/main/packages/agboss/tests/faults))
and on PostgreSQL in agbossjs/postgres
([`tests/faults/`](https://github.com/agbossjs/postgres/tree/main/tests/faults)); the scenarios are
[`packages/agboss/src/testing/faults/scenarios/`](https://github.com/agbossjs/agboss/tree/main/packages/agboss/src/testing/faults/scenarios):

| # | Scenario | File |
| --- | --- | --- |
| 1, 1b | SIGTERM during a step: drained there; with a shorter `shutdownTimeout`, handed over | [`s01-sigterm.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s01-sigterm.ts) |
| 2 | SIGKILL mid-step: taken over from the last checkpoint | [`s02-kill.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s02-kill.ts) |
| 3, 3b | a crash after the effect committed (and after the gateway answered), before the checkpoint: replayed | [`s03-crash-after-effect.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s03-crash-after-effect.ts) |
| 4 | a lease expires (renewals stall): the step stops, another pod takes over | [`s04-lease-expiry.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s04-lease-expiry.ts) |
| 5, 5b, 5c | a frozen pod comes back: its stale write refused | [`s05-zombie.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s05-zombie.ts) |
| 5d | a zombie between its payment's intent and its send: reconciled, paid once | [`s05d-recorded-not-sent.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s05d-recorded-not-sent.ts) |
| 6, 6b | scale-down while children run; a frozen ask for a finished child's lease | [`s06-children.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s06-children.ts) |
| 7 | a new pod joins and claims the queued child | [`s07-new-pod.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s07-new-pod.ts) |
| 8, 8b | a pod loses its database; the database comes back after the lease expired | [`s08-database-loss.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s08-database-loss.ts) |
| 9, 10 | a crash after sending, before the answer: reconciled; one order, two executions: one payment | [`s09-s10-gateway.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s09-s10-gateway.ts) |
| 11, 11b | a 10 s grace: `shutdownTimeout` below it hands over in time; above it, killed mid-drain, recovered | [`s11-short-grace.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s11-short-grace.ts) |
| 12, 12b | a real failure undoes once, across a kill; a marked undo never again | [`s12-real-failure.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s12-real-failure.ts), [`s12b-marked-undo.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s12b-marked-undo.ts) |
| 13 | a pod's clock ten leases ahead or behind | [`s13-clock-skew.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/src/testing/faults/scenarios/s13-clock-skew.ts) |
| #487 | the whole cycle on kind and PostgreSQL, verified from state | [`scenario.mjs`](https://github.com/agbossjs/agboss-examples/blob/main/14-kubernetes-postgres-scaling/scripts/cluster/scenario.mjs), [`verify.ts`](https://github.com/agbossjs/agboss-examples/blob/main/14-kubernetes-postgres-scaling/src/verification/verify.ts) |
