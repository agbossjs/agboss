import { checkedCallerId, checkedTenantId } from "../flow/context/context-values.js";
import { ExecutionContextUnavailableError } from "../flow/context/errors.js";
import { currentFrame, type Frame } from "../flow/context/frame.js";
import { liveExecutionContextOf } from "../flow/context/live-context.js";
import { RagScopeError } from "../rag/rag-source.js";
import { RagScope, type RagScopeKey } from "../rag/types.js";
import type { WorkflowServices } from "../workflow.js";
import type { RagMeta } from "./rag.js";

/** What resolves a scope's id: the call's frame, the source and the application's services. */
interface ScopeCall {
  readonly consumer: string;
  readonly frame: Frame;
  readonly source: object;
  readonly services: WorkflowServices;
}

const tenantScope = ({ frame }: ScopeCall): string => {
  const { tenantId } = frame.execution.tenant;
  checkedTenantId(tenantId);
  return tenantId;
};

const ownerScope = ({ consumer, frame }: ScopeCall): string => {
  const { ownerId } = frame.execution;
  if (ownerId === undefined)
    throw new RagScopeError({
      message: `[rag.scope-unresolved] ${consumer} has scope RagScope.Owner and this execution has no owner — pass owner in the call's options`,
    });
  checkedCallerId(consumer, "owner", ownerId);
  return ownerId;
};

const customScope = ({ consumer, source, services }: ScopeCall): string => {
  const resolve: unknown = Reflect.get(source, "resolveScope");
  if (typeof resolve !== "function")
    throw new RagScopeError({
      message: `[rag.custom-scope-missing-resolver] ${consumer} has scope RagScope.Custom and no resolveScope(context)`,
    });
  const context = liveExecutionContextOf(services.contexts?.executionContext, consumer);
  const id: unknown = Reflect.apply(resolve, source, [context]);
  if (typeof id !== "string" || id === "")
    throw new RagScopeError({
      message: `[rag.scope-unresolved] ${consumer}: resolveScope returned no scope id — a custom scope names one on every call`,
    });
  checkedCallerId(consumer, "scopeId", id);
  return id;
};

/** The scopes that name an id, by the way each resolves it; `Shared` names none. */
const RESOLVERS: Readonly<Partial<Record<RagScope, (call: ScopeCall) => string>>> = {
  [RagScope.Tenant]: tenantScope,
  [RagScope.Owner]: ownerScope,
  [RagScope.Custom]: customScope,
};

/**
 * The scope's key of a retrieval — its tenant and its id within it, none for `Shared` — resolved from the frame of the step or tool call that runs it, and
 * checked as a key's text (`validation.dto-invalid` naming the rule, never the id). No open frame →
 * `context.unavailable`. A scope the call cannot resolve (an owner-scoped source without an owner, a
 * custom scope that returns nothing, a scope that is none of the four) fails closed — never another
 * scope's passages.
 */
export function scopeKeyOfRetrieval(
  meta: RagMeta,
  source: object,
  services: WorkflowServices,
): RagScopeKey {
  const frame = currentFrame();
  const consumer = `@Rag ${meta.name}`;
  if (frame === undefined)
    throw ExecutionContextUnavailableError.outside({ consumer, field: "executionContext" });
  if (frame.isClosed())
    throw ExecutionContextUnavailableError.ended(frame.step, frame.execution.executionId);
  if (meta.scope === RagScope.Shared) return {};
  const resolve = RESOLVERS[meta.scope];
  if (resolve === undefined)
    throw new RagScopeError({
      message: `[rag.scope-required] ${consumer} declares no known scope — scope: RagScope.Shared, Tenant, Owner or Custom`,
    });
  // every non-global scope is bound to the tenant: an owner id or a custom key is unique within one
  const { tenantId } = frame.execution.tenant;
  checkedTenantId(tenantId);
  return {
    tenantId,
    scopeId: resolve({ consumer, frame, source, services }),
    scope: meta.scope,
  };
}
