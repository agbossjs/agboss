# Health checks

An orchestrator (Kubernetes, Cloud Run, a load balancer) asks each instance two questions: is the
process alive — restart it otherwise — and may it take traffic. An application instance answers
both (#300): `app.checkLiveness()` and `app.checkReadiness()`. The framework opens no port and no
endpoint: the project's own server exposes the two methods.

| Probe | What it checks | I/O |
| --- | --- | --- |
| `app.checkLiveness()` | the application — `Unhealthy` (`stopping`) from `app.close()` on; the recovery loop — `Unhealthy` (`stuck: …`) when its last sweep ended more than three sweep intervals (90 s) ago on the `Clock` | none |
| `app.checkReadiness()` | liveness's components; every store's `ping()`; every model provider's circuit breaker (open → `Degraded`); every `@HealthCheck` of `@Application({ healthChecks })` | one round trip per store, the breakers' state, the project's checks |

Neither call ever rejects. Readiness runs its checks at once, each under its own timeout on the
application's `Clock` (stores and model providers `seconds(2)`, a project check its `timeout`); a
check that throws or passes its timeout is that component's `Unhealthy`, its `reason` the error's
message or `timed out after 2 s`. No check calls a model: a provider's breaker is read from
`RateLimitRepository`, where every instance keeps it ([Model providers](Model-providers#retry-rate-limit-and-circuit-breaker)).

## The report

```json
{
  "status": "degraded",
  "components": [
    { "name": "shop-application", "kind": "application", "status": "healthy", "duration": 0 },
    { "name": "recovery-loop", "kind": "recovery-loop", "status": "healthy", "duration": 0 },
    { "name": "SqliteCostLedgerRepository", "kind": "store", "status": "healthy", "duration": 1 },
    { "name": "SqliteCheckpointSaver", "kind": "store", "status": "healthy", "duration": 0 },
    {
      "name": "openrouter-model-provider",
      "kind": "model-provider",
      "status": "degraded",
      "reason": "circuit breaker open until 2026-10-21T09:01:00.000Z",
      "duration": 0
    },
    { "name": "crm-health-check", "kind": "project", "status": "healthy", "duration": 42 },
    {
      "name": "step-slots",
      "kind": "step-slots",
      "status": "degraded",
      "reason": "32 of 32 step slots busy, 7 steps waiting",
      "duration": 0
    }
  ]
}
```

- `HealthReport { status, components }` — `status` is the worst component's:
  `HealthStatus.Healthy` < `Degraded` < `Unhealthy`.
- `HealthComponentReport { name, kind, status, reason?, duration }` — `kind` a
  `HealthComponentKind`: `Application` (its `name` the application's), `RecoveryLoop`
  (`recovery-loop`), `Store` (the implementation's class: one per #265 contract and the checkpoint
  saver), `ModelProvider` (the provider's `name`), `Project` (the check's `name`), `StepSlots`
  (`step-slots`, #332: only when `@Application({ maxConcurrentSteps })` is set — readiness only,
  `Degraded` while every step slot of the instance is busy, its `reason` the busy, the cap and the
  waiting steps; [Several instances](Several-instances#an-instances-cap-on-steps-332)); `duration` in
  milliseconds on the `Clock`.

## A project's own check

A dependency of the project — a CRM, a queue, a search index — is checked by a `@HealthCheck`
class: `name` ends with `-health-check`, `timeout` is required, `deps` are injected like any
component's (checked against the constructor by the compiler). `check()` returns a
`HealthCheckResult`, built only with `HealthCheckResult.healthy()`,
`HealthCheckResult.degraded({ reason })` or `HealthCheckResult.unhealthy({ reason })` — a plain
object does not compile.

```ts file=crm.ts
import { HealthCheck, HealthCheckResult, Injectable, type HealthCheckHandler } from "agboss";
import { seconds } from "agboss/units";

@Injectable()
export class CrmClient {
  ping(): Promise<boolean> {
    return Promise.resolve(true); // e.g. GET /status of the CRM
  }
}

@HealthCheck({ name: "crm-health-check", timeout: seconds(2), deps: [CrmClient] })
export class CrmHealthCheck implements HealthCheckHandler {
  constructor(private readonly crmClient: CrmClient) {}

  async check(): Promise<HealthCheckResult> {
    const isReachable: boolean = await this.crmClient.ping();
    return isReachable
      ? HealthCheckResult.healthy()
      : HealthCheckResult.unhealthy({ reason: "CRM is unreachable" });
  }
}
```

It is listed only in `@Application({ healthChecks: [CrmHealthCheck] })` and created by the
application's container at start (a missing dependency fails the start). The assembly checks the
list with the application's other rules, every violation at once: `[health.not-a-health-check]` (a
class without the decorator), `[name.kind-suffix]` (a name without `-health-check`),
`[health.duplicate-name]` (two checks of one name).

## Exposing the probes

The project's server maps the reports to its probe endpoints — here with `node:http`: `Unhealthy`
is `503`, anything else `200` (a `Degraded` instance still serves: its fallback provider answers,
or its calls fail fast while the breaker is open).

<!-- snippet-context
import type { App } from "agboss";
declare const app: App;
-->

```ts
import { createServer } from "node:http";
import { HealthStatus, type HealthReport } from "agboss";

/** The probe a path asks for; `undefined` for any other path. */
const probeOf = (path: string | undefined): Promise<HealthReport> | undefined =>
  path === "/livez" ? app.checkLiveness() : path === "/readyz" ? app.checkReadiness() : undefined;

createServer((request, response) => {
  const probe = probeOf(request.url);
  if (probe === undefined) {
    response.writeHead(404).end();
    return;
  }
  void probe.then((report) => {
    const statusCode = report.status === HealthStatus.Unhealthy ? 503 : 200;
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify(report));
  });
}).listen(8080);
```

During a rolling deploy the stopping instance turns `Unhealthy` as soon as `app.close()` (or
SIGTERM) begins, so the orchestrator stops sending it requests while it drains its running
executions ([App → `app.close`](App#appcloseoptions), [Several instances](Several-instances#probes-of-an-instance-300)).

## Stores: `ping()`

Every store contract of #265 — `CostLedgerRepository`, `ExecutionRecordRepository`,
`PausedExecutionRepository`, `ExecutionLeaseRepository`, `ExecutionTreeRepository`,
`RateLimitRepository` — has `abstract ping(): Promise<void>`: one fast round trip that resolves when
the store answers and rejects with why when it does not, never a scan. The in-memory defaults
resolve; the SQLite ones run `SELECT 1` on their connection (a closed connection or an unreadable
file rejects). A project's own implementation adds it — a Redis one `PING`, a SQL one `SELECT 1`.
The checkpoint saver is LangGraph's contract: the framework's own (the in-memory default,
`SqliteCheckpointSaver`) have a `ping()`; any other saver is asked for the latest checkpoint of a
thread that does not exist — one read, nothing written.

## Testing

`testWith`'s `app` has both probes — also during and after `app.close()`, when an orchestrator still
asks. A dependency is taken down the real way, through its mock; a timeout is reached by moving the
test's clock:

<!-- snippet-context
import { expect } from "vitest";
import { HealthStatus } from "agboss";
import { testWith } from "agboss/testing";
import { CrmClient } from "./crm.js";
declare class ShopApplication {}
-->

```ts
import { seconds } from "agboss/units";

const test = testWith(ShopApplication);

test("an unreachable CRM makes the instance not ready", async ({ app, mockOf }) => {
  mockOf(CrmClient).ping.mockResolvedValue(false);

  const report = await app.checkReadiness();

  expect(report.status).toBe(HealthStatus.Unhealthy);
  expect(report.components).toContainEqual(
    expect.objectContaining({ name: "crm-health-check", reason: "CRM is unreachable" }),
  );
});

test("a CRM that does not answer within its timeout counts as failed", async ({
  app,
  clock,
  mockOf,
}) => {
  mockOf(CrmClient).ping.mockImplementation(() => clock.sleep(seconds(5)).then(() => true));
  await app.ready();

  const pending = app.checkReadiness();
  await clock.advance(seconds(3));

  expect((await pending).status).toBe(HealthStatus.Unhealthy); // "timed out after 2 s"
});
```

Later (#332): the instance's free execution slots join the components (`Degraded` when full).
