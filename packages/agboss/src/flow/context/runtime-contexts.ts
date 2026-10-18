import { randomUUID } from "node:crypto";
import { applicationContextOf, type ApplicationContext } from "./application-context.js";
import { NO_ENVIRONMENT_VALUES } from "../../environments/resolve.js";
import { systemClock, type Clock } from "../../infrastructure/clock.js";
import type { Environment } from "../generated-types.js";
import {
  DEFAULT_TENANT,
  executionFieldsOf,
  tenantContextOf,
  tenantFieldsOf,
  type ExecutionContextClass,
  type ExecutionContextValues,
  type TenantContextClass,
  type TenantFields,
} from "./context-values.js";
import { ExecutionContext } from "./execution-context.js";
import { TenantContext } from "./tenant-context.js";

/**
 * The context levels of an application instance at run time (#261, internal): its one
 * `ApplicationContext` and the classes it declared for the levels below
 * (`@Application({ tenantContext, executionContext })`, else the built-in ones).
 */
export interface RuntimeContexts {
  readonly application: ApplicationContext;
  readonly tenantContext: TenantContextClass;
  readonly executionContext: ExecutionContextClass;
}

/**
 * What a workflow run without an application gets (eval, replay): its own name, no settings, its
 * start read from `clock`.
 */
export function standaloneContexts(
  workflow: { readonly name: string; readonly version: string },
  environment: Environment = NO_ENVIRONMENT_VALUES,
  clock: Clock = systemClock,
): RuntimeContexts {
  return {
    application: applicationContextOf({
      name: workflow.name,
      version: workflow.version,
      instanceId: randomUUID(),
      startedAt: clock.now(),
      environmentName: "dev",
      environment,
    }),
    tenantContext: TenantContext,
    executionContext: ExecutionContext,
  };
}

/** One tenant instance per kept values object: every step of an execution sees the same object. */
const tenants = new WeakMap<TenantFields, WeakMap<ApplicationContext, TenantContext>>();

/** The execution's tenant: an instance of the declared class over its values, linked up, frozen. */
export function tenantOfExecution(contexts: RuntimeContexts, values: TenantFields): TenantContext {
  const byApplication = tenants.get(values) ?? new WeakMap<ApplicationContext, TenantContext>();
  tenants.set(values, byApplication);
  const known = byApplication.get(contexts.application);
  if (known !== undefined) return known;
  const tenant = tenantContextOf(contexts.tenantContext, values, contexts.application);
  byApplication.set(contexts.application, tenant);
  return tenant;
}

/** The default tenant of an application (a call outside any execution: a tool called over MCP). */
export const defaultTenantOf = (contexts: RuntimeContexts): TenantContext =>
  tenantOfExecution(contexts, DEFAULT_TENANT);

/** What a caller passes for the contexts (`app.execute(…, { tenant, execution })`), unchecked. */
export interface GivenContextValues {
  readonly tenant?: unknown;
  readonly execution?: unknown;
}

/**
 * The context values of a new execution: checked against the declared classes before the first
 * step (invalid → `DtoValidationError`, `dto.invalid`, naming the field and never the value),
 * frozen. Nothing passed → the tenant `"default"`; `execution` with the built-in class is invalid.
 */
export const contextValuesOf = (
  contexts: RuntimeContexts,
  given: GivenContextValues,
): ExecutionContextValues => ({
  tenant: tenantFieldsOf(contexts.tenantContext, given.tenant),
  execution: executionFieldsOf(contexts.executionContext, given.execution),
});
