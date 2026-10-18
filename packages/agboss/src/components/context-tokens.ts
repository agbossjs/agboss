import { ApplicationContext } from "../flow/context/application-context.js";
import type { ExecutionContextClass, TenantContextClass } from "../flow/context/context-values.js";
import { ExecutionContext } from "../flow/context/execution-context.js";
import { liveExecutionContextOf, liveTenantContextOf } from "../flow/context/live-context.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import { TenantContext } from "../flow/context/tenant-context.js";
import { DependantValue } from "./container/container.js";
import { tokenName, type Token } from "./injection.js";
import { ComponentError } from "./metadata.js";

/**
 * The context tokens of the container (#261): exactly three levels, each its type and its token —
 * `ApplicationContext` (the one object of the instance), `TenantContext` and `ExecutionContext`
 * (live objects per consumer, reading the current execution) — and the project's subclasses
 * declared in `@Application({ tenantContext, executionContext })`, each its own token. A level's
 * base token gives the declared subclass too.
 */

/** The three levels: always registered. */
export const CONTEXT_TOKENS: readonly Token[] = [
  ApplicationContext,
  TenantContext,
  ExecutionContext,
];

/** The tokens of an application's contexts: the three levels and its declared subclasses. */
export const contextTokensOf = (
  declared: Pick<RuntimeContexts, "tenantContext" | "executionContext">,
): readonly Token[] => [
  ...new Set<Token>([...CONTEXT_TOKENS, declared.tenantContext, declared.executionContext]),
];

const liveTenant = (type: TenantContextClass): DependantValue =>
  new DependantValue((dependant) => liveTenantContextOf(type, dependant));

const liveExecution = (type: ExecutionContextClass): DependantValue =>
  new DependantValue((dependant) => liveExecutionContextOf(type, dependant));

/** The core values of the context tokens of an application instance. */
export function contextValuesOf(contexts: RuntimeContexts): ReadonlyMap<Token, unknown> {
  const { application, tenantContext, executionContext } = contexts;
  return new Map<Token, unknown>([
    [ApplicationContext, application],
    [TenantContext, liveTenant(tenantContext)],
    [tenantContext, liveTenant(tenantContext)],
    [ExecutionContext, liveExecution(executionContext)],
    [executionContext, liveExecution(executionContext)],
  ]);
}

/** Whether `token` is a context class (a level or a subclass of one). */
const isContextClass = (token: Token): boolean =>
  typeof token === "function" &&
  (token.prototype instanceof TenantContext ||
    token.prototype instanceof ExecutionContext ||
    token.prototype instanceof ApplicationContext);

/**
 * A context subclass a component injects that its application does not declare: the fix named
 * (`[context.not-declared]`); `undefined` for any other token.
 */
export function undeclaredContextError(
  token: Token,
  dependant: string,
): ComponentError | undefined {
  if (!isContextClass(token)) return undefined;
  const name = tokenName(token);
  const option =
    typeof token === "function" && token.prototype instanceof TenantContext
      ? "tenantContext"
      : "executionContext";
  return new ComponentError(
    `[context.not-declared] ${dependant} injects ${name}, which its application does not declare — @Application({ ${option}: ${name} })`,
  );
}
