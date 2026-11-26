import { ValidationError } from "../core/error-families/effect-errors.js";

/**
 * The runtime side of the tenant-safety types (#1324e). An application that declares a
 * `tenantContext` serves many tenants, so a call that needs one and names none is refused at its
 * entry — before any store is read, never run as the tenant `"default"` and never masked as a
 * `NotFound`. An application without one has the one tenant `"default"`, which a call may omit.
 */

/** The calls of `App` that need a tenant, by the operation `ValidationError.TenantRequired` names. */
export enum TenantOperation {
  Execute = "execute",
  Resume = "resume",
  Cancel = "cancel",
  Stop = "stop",
  Pause = "pause",
  Unpause = "unpause",
  SetPauseTimeout = "setPauseTimeout",
  ReassignPause = "reassignPause",
  GetExecution = "getExecution",
  GetStatusHistory = "getStatusHistory",
  ListExecutions = "listExecutions",
  ListPauses = "listPauses",
  AuditLogOf = "auditLogOf",
  OutboundCallsOf = "outboundCallsOf",
  PendingOutboundCallsOf = "pendingOutboundCallsOf",
  /** `app.runAction` / `runAgent` / `runRouter` / `runTool` of a test app (#1328). */
  RunAction = "runAction",
  RunAgent = "runAgent",
  RunRouter = "runRouter",
  RunTool = "runTool",
}

/** A tenant as a call names it: a `string` (whether its text is a key's is checked where it is read). */
export const isNamedTenant = (tenantId: unknown): tenantId is string =>
  typeof tenantId === "string";

/**
 * Refuses a call that names no tenant when the application declares a `tenantContext`
 * (`ValidationError.TenantRequired`, `validation.tenant-required`); returns the tenant it names, or
 * `undefined` when the application has none and the call named none.
 */
export function checkedTenant(
  hasTenantContext: boolean,
  operation: TenantOperation,
  tenantId: unknown,
): string | undefined {
  if (isNamedTenant(tenantId)) return tenantId;
  if (hasTenantContext) {
    throw new ValidationError.TenantRequired({
      operation,
      help: `pass { tenantId } to app.${operation}(): the application declares a tenantContext, so no call defaults to another tenant`,
    });
  }
  return undefined;
}
