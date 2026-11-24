import type { AnyTenantApp } from "../app/types.js";
import { checkedTenant, TenantOperation } from "../app/tenant-gate.js";

/**
 * The tenant gate of an application instance's `App` (#1324e). An application that declares a
 * `tenantContext` serves many tenants, so a call that needs one and names none is refused at its
 * entry with `ValidationError.TenantRequired` — before the call routes to a workflow or reads any
 * store, so a missing tenant is never run as `"default"` and never shows up as a `NotFound`. An
 * application without one passes every call through: its one tenant is `"default"`.
 */

/** The `tenantId` a call's `tenant` values carry, when they are an object that has one (unchecked). */
const tenantIdOfValues = (tenant: unknown): unknown =>
  typeof tenant === "object" && tenant !== null
    ? (tenant as { readonly tenantId?: unknown }).tenantId
    : undefined;

/** The `tenantId` of a call's options, when they are an object that has one (unchecked). */
const tenantIdOf = (options: unknown): unknown =>
  typeof options === "object" && options !== null
    ? (options as { readonly tenantId?: unknown }).tenantId
    : undefined;

/** What the gate refuses a call for: the operation, and the tenant it names. */
type Need = (operation: TenantOperation, named: unknown) => void;

/** The calls of `app` on one thing, gated. */
const pointCallsOf = (app: AnyTenantApp, need: Need): Partial<AnyTenantApp> => ({
  execute: async (start, input, ...options) => {
    const given = options[0] as { readonly tenant?: unknown } | undefined;
    need(TenantOperation.Execute, tenantIdOfValues(given?.tenant));
    return app.execute(start, input, ...options);
  },
  resume: async (request, options) => {
    need(TenantOperation.Resume, tenantIdOf(options));
    return app.resume(request, options);
  },
  cancel: async (threadId, options) => {
    need(TenantOperation.Cancel, tenantIdOf(options));
    return app.cancel(threadId, options);
  },
  extendPause: async (request, options) => {
    need(TenantOperation.ExtendPause, tenantIdOf(options));
    return app.extendPause(request, options);
  },
  reassignPause: async (request, options) => {
    need(TenantOperation.ReassignPause, tenantIdOf(options));
    return app.reassignPause(request, options);
  },
  getExecution: async (executionId, options) => {
    need(TenantOperation.GetExecution, tenantIdOf(options));
    return app.getExecution(executionId, options);
  },
});

/** The reads of `app` over a tenant's data, gated. */
const readsOf = (app: AnyTenantApp, need: Need): Partial<AnyTenantApp> => ({
  listExecutions: async (query) => {
    const { allTenants } = (query ?? {}) as { readonly allTenants?: unknown };
    if (allTenants !== true) need(TenantOperation.ListExecutions, tenantIdOf(query));
    return app.listExecutions(query);
  },
  listPauses: async (query) => {
    need(TenantOperation.ListPauses, tenantIdOf(query));
    return app.listPauses(query);
  },
  auditLogOf: async (tree) => {
    need(TenantOperation.AuditLogOf, tenantIdOf(tree));
    return app.auditLogOf(tree);
  },
  outboundCallsOf: async (tree) => {
    need(TenantOperation.OutboundCallsOf, tenantIdOf(tree));
    return app.outboundCallsOf(tree);
  },
  pendingOutboundCallsOf: async (query) => {
    need(TenantOperation.PendingOutboundCallsOf, tenantIdOf(query));
    return app.pendingOutboundCallsOf(query);
  },
});

/** `app`, its calls that need a tenant refused first when the application `tenanted` names none. */
export function tenantGated(tenanted: boolean, app: AnyTenantApp): AnyTenantApp {
  if (!tenanted) return app;
  const need: Need = (operation, named) => {
    checkedTenant(true, operation, named);
  };
  return { ...app, ...pointCallsOf(app, need), ...readsOf(app, need) };
}
