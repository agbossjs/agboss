---
section: Breaking
issue: 1324
---

**`App<TApp>` asks for the tenant in its types and refuses a call without one at run time** (#1324e): `createApp` returns `App<InstanceType<TApplication>>`. When the application declares a `tenantContext`, the point calls (`resume`, `cancel`, `setPauseTimeout`, `reassignPause`, `getExecution`) take `{ tenantId }` as a required options argument, and a listing (`listExecutions`) takes one `tenantId` or `allTenants: true`, never both; an application not branded by the generated `.agboss/types.d.ts` counts as tenanted, so the tenant is never silently the default. At run time every call that needs a tenant (`execute`, `resume`, `cancel`, `setPauseTimeout`, `reassignPause`, `getExecution`, `listExecutions`, `listPauses`, `auditLogOf`, `outboundCallsOf`, `pendingOutboundCallsOf`) and names none rejects at its entry with `ValidationError.TenantRequired` (`validation.tenant-required`, `{ operation }`), before any store is read; without a `tenantContext` the tenant stays optional (`"default"`).

**Added:** `app.getExecution(executionId, { tenantId? })` and `app.listExecutions({ tenantId? | allTenants?, startedAfter?, startedBefore?, workflow?, status?, cursor?, limit? })` returning `Page<ExecutionHistoryRecord>`, over the kept root executions (`ExecutionsQuery`, `Date | string` bounds); `createApp({ handleSignals, processEnv })`. **Changed:** `createApp` no longer listens for SIGTERM / SIGINT unless `handleSignals: true` (the CLI passes `true`).
