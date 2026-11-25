/**
 * Multi-tenant safety in the types of `App` (#1324e). Whether an application declares a
 * `tenantContext` decides whether a call must name its tenant: with none, `tenantId` is optional
 * (the tenant `"default"`); with one, a call without it does not compile, and at run time it is
 * refused at entry with `ValidationError.TenantRequired`, before any store is read.
 */

/**
 * The brand `.agboss/types.d.ts` merges into an application class (like `agbossComponent`): `true`
 * when `@Application({ tenantContext })` is declared, `false` when it is not.
 */
export const agbossTenantContext: unique symbol = Symbol("agboss.tenantContext");

/** A class branded with whether its application declares a `tenantContext`. */
export interface TenantContextBranded<THas extends boolean> {
  readonly [agbossTenantContext]?: THas;
}

/**
 * Whether the application `TApp` declares a `tenantContext`. Fail-safe: `false` only when the
 * brand says `false`; `unknown`, `any`, an application not yet generated, or a brand that is not
 * a plain boolean all count as `true`, so a tenant is never silently defaulted.
 */
export type HasTenantContext<TApp> = unknown extends TApp
  ? true
  : TApp extends TenantContextBranded<infer THas>
    ? [THas] extends [false]
      ? false
      : true
    : true;

/** The tenant a call names: any `string`. */
export interface TenantIdOption {
  readonly tenantId: string;
}

/**
 * The arguments after the target of a call on one thing (`pause`, `unpause`, `stop`, `cancel`,
 * `resume`, `setPauseTimeout`, `reassignPause`, `getExecution`, `getStatusHistory`): the options
 * are optional while the application has no `tenantContext`, else required and with a `tenantId`.
 */
export type TenantPointArgs<TApp, TOptions extends object = object> =
  HasTenantContext<TApp> extends false
    ? [options?: TOptions & { readonly tenantId?: string }]
    : [options: TOptions & TenantIdOption];

/** A listing's scope with a `tenantContext`: one tenant, or every tenant, never both. */
export type TenantListScope =
  | { readonly tenantId: string; readonly allTenants?: never }
  | { readonly allTenants: true; readonly tenantId?: never };

/**
 * The query of a listing (`listExecutions`, `listPauses`, `listOutboundCalls`, `listAuditEvents`):
 * optional while the application has no `tenantContext`, else required and naming either one
 * `tenantId` or `allTenants: true`.
 */
export type TenantListArgs<TApp, TQuery extends object = object> =
  HasTenantContext<TApp> extends false
    ? [query?: TQuery & { readonly tenantId?: string }]
    : [query: TQuery & TenantListScope];
