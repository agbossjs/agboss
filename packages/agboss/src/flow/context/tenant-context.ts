import type { ApplicationContext } from "./application-context.js";

/**
 * The tenant level (#261): the organization an execution works for — `tenantId`, its `weight` in
 * the model providers' queues (#266 S60) and the project's own fields. The project extends it by
 * subclassing, with DTO field decorators, and declares the subclass once in
 * `@Application({ tenantContext })`. The values come per execution (`app.execute(…, { tenant })`),
 * validated, frozen and inherited by child executions; the project never creates one with `new`.
 */

/** The tenant of an application that passes none: a single-tenant application has one. */
export const DEFAULT_TENANT_ID = "default";

/** A tenant's weight when none is given: one share of a provider's slots per round (#266 S60). */
export const DEFAULT_TENANT_WEIGHT = 1;

/**
 * The organization of the current execution: the type and the DI token (`deps: [TenantContext]`,
 * or the project's subclass). The injected object reads the current execution on every access; a
 * read outside an execution throws `ExecutionContextUnavailableError`.
 */
export abstract class TenantContext {
  // `declare`: the framework sets them on its own instance; a subclass adds its fields only
  /** The organization; `"default"` when the execution names none. */
  declare readonly tenantId: string;
  /** A positive integer, default 1: its share of a provider's slots under `TenantWeighted`. */
  declare readonly weight: number;
  /** The application the tenant's execution runs in: the one `ApplicationContext` of the instance. */
  declare readonly application: ApplicationContext;
}
