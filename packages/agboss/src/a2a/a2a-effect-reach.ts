import { ComponentKind } from "../flow/runtime/records.js";
import type { ApplicationOptions } from "../application/application.js";
import { Idempotency } from "../app/idempotency.js";
import { implementsContract } from "../components/container/registrations.js";
import { ComponentOptions } from "../components/component-options.js";
import { CONTEXT_TOKENS } from "../components/context-tokens.js";
import { createdClassesOf, type Class, type Token } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { Clock, IdGenerator, StoreClock } from "../infrastructure/clock.js";
import { CONTAINER_DEFAULTS } from "../infrastructure/contracts.js";
import { FencedEffectRepository } from "../infrastructure/fenced-effect.repository.js";

/** The tokens whose use changes things outside the run: a fenced effect, a call that leaves. */
const EFFECT_TOKENS: ReadonlySet<Token> = new Set<Token>([Idempotency, FencedEffectRepository]);

/** The declared `deps` of a token, any kind (a node's options, a component's meta); none for others. */
function depsOf(token: Token): readonly Token[] {
  const declared = declarationOf(token)?.options ?? componentOf(token)?.meta;
  const deps: unknown = declared !== undefined && "deps" in declared ? declared.deps : undefined;
  // a decorator records `deps` as the tokens it was given
  // Stryker disable next-line ArrayDeclaration: a text in place of no deps is a token of nothing
  return Array.isArray(deps) ? (deps as readonly Token[]) : [];
}

/**
 * Whether a token changes things outside the run: an effect store, `OutboundCalls`, an A2A client,
 * an MCP server — each a class.
 */
const isEffect = (token: Token): token is Class =>
  EFFECT_TOKENS.has(token) ||
  componentOf(token)?.kind === "a2a-agent" ||
  componentOf(token)?.kind === "mcp-server";

/**
 * The classes an application can bind to a port: its providers and services, and those of its
 * workflows. A dependency on a port reaches whichever of them implements it.
 */
export function boundClassesOf(options: ApplicationOptions): readonly Class[] {
  const entries = (list: readonly unknown[] | undefined): readonly Class[] =>
    createdClassesOf((list ?? []) as Parameters<typeof createdClassesOf>[0]);
  const workflows = withChildWorkflows(options.workflows).flatMap((workflow) => {
    const declared = declarationOf(workflow);
    return declared?.kind === ComponentKind.Workflow
      ? [...entries(declared.options.providers), ...entries(declared.options.services)]
      : [];
  });
  return [...entries(options.providers), ...entries(options.services), ...workflows];
}

/** The tokens the container itself provides to every application: the clocks, the contexts, the options of the components (#1318c). */
const CORE_TOKENS: ReadonlySet<Token> = new Set<Token>([
  Clock,
  ComponentOptions,
  StoreClock,
  IdGenerator,
  ...CONTEXT_TOKENS,
]);

/** The bound classes that are `dep`, extend it, or name it in `injectAs`; none for a value token. */
const implementersOf = (dep: Token, bound: readonly Class[]): readonly Class[] =>
  typeof dep === "function" && typeof dep.prototype === "object"
    ? bound.filter((cls) => cls !== dep && implementsContract(cls, dep as Class))
    : [];

/** A core token, or a class that extends one (an application's own `ExecutionContext`). */
const isCoreToken = (dep: Class): boolean =>
  CORE_TOKENS.has(dep) ||
  [...CORE_TOKENS].some(
    (core) =>
      typeof core === "function" &&
      typeof dep.prototype === "object" &&
      dep.prototype instanceof core,
  );

/**
 * Whether a dependency is a class that nothing says what it is: no decorator and no bound class
 * that implements it — a port whose implementation cannot be seen, so (fail closed) an effect.
 */
const isUnresolvedPort = (dep: Token, bound: readonly Class[]): dep is Class =>
  typeof dep === "function" &&
  componentOf(dep) === undefined &&
  declarationOf(dep) === undefined &&
  !EFFECT_TOKENS.has(dep) &&
  !isCoreToken(dep) &&
  !CONTAINER_DEFAULTS.has(dep) &&
  implementersOf(dep, bound).length === 0;

/**
 * The first effect `token`'s `deps` reach, through the tokens it injects and, for a port, the
 * classes bound to it (`injectAs`, a subclass); `undefined` for none. A port nothing bound
 * implements counts as the effect itself.
 */
export function effectOf(
  token: Token,
  bound: readonly Class[],
  seen = new Set<Token>(),
): Class | undefined {
  for (const dep of depsOf(token)) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const found = effectBehind(dep, bound, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The effect a dependency is, is bound to, or reaches through its own `deps`. */
function effectBehind(dep: Token, bound: readonly Class[], seen: Set<Token>): Class | undefined {
  if (isEffect(dep)) return dep;
  if (isUnresolvedPort(dep, bound)) return dep;
  for (const impl of implementersOf(dep, bound)) {
    if (isEffect(impl)) return impl;
    if (seen.has(impl)) continue;
    seen.add(impl);
    const viaImpl = effectOf(impl, bound, seen);
    if (viaImpl !== undefined) return viaImpl;
  }
  return effectOf(dep, bound, seen);
}
