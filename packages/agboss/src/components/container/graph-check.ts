import { InjectionToken, tokenName, type Class, type Token } from "../injection.js";
import { ComponentError } from "../metadata.js";
import { depsOf } from "./container.js";
import { Registrations, type ProviderModule, type Registration } from "./registrations.js";
import { CONTAINER_DEFAULTS, infrastructureContractOf } from "../../infrastructure/contracts.js";
import { undeclaredContextError } from "../context-tokens.js";

/** Core tokens as registrations for the checks: their values are not needed to check the graph. */
const coreOf = (core: readonly Token[]): ReadonlyMap<Token, unknown> =>
  new Map(core.map((token) => [token, undefined]));

/** A class's dependencies as a readable tree: `JobFitJudge (ROUTER_FACTORY), JOB_SEARCH`. */
export function dependencyTree(cls: Class, modules: readonly ProviderModule[]): string {
  const registrations = new Registrations(modules, new Map());
  const render = (deps: readonly Token[], dependant: string): string =>
    deps
      .map((dep) => {
        const found = registrations.find(dep, dependant);
        const inner = found?.kind === "class" ? depsOf(found.cls) : [];
        return inner.length === 0
          ? tokenName(dep)
          : `${tokenName(dep)} (${render(inner, tokenName(dep))})`;
      })
      .join(", ");
  return render(depsOf(cls), tokenName(cls));
}

/**
 * An unlisted class under an infrastructure implementation (#526 AC8: `SqliteConnection`,
 * `PostgresConnection` under the store `OutboundCalls` uses): its own registration, as the
 * application's container creates it — never an `InjectionToken`, and never a workflow's service.
 */
const ownRegistrationOf = (dep: Token, isUnderStore: boolean): Registration | undefined =>
  isUnderStore && !(dep instanceof InjectionToken) ? { kind: "class", cls: dep } : undefined;

/** What `dep` of `dependant` resolves to; nothing → the error that says why. */
function registrationOf(
  registrations: Registrations,
  dep: Token,
  dependant: string,
  isUnderStore: boolean,
): Registration {
  const found = registrations.find(dep, dependant);
  if (found !== undefined) return found;
  const context = undeclaredContextError(dep, dependant);
  if (context !== undefined) throw context;
  const own = ownRegistrationOf(dep, isUnderStore);
  if (own !== undefined) return own;
  throw new ComponentError(
    `${dependant}: "${tokenName(dep)}" is not registered in @Workflow({ providers })`,
  );
}

/**
 * Checks the dependency graph of `roots` without creating anything: every dependency registered (a
 * contract by one implementation, an infrastructure contract else by its built-in default), no
 * cycles, no conflicting values. Errors name the component and the chain.
 */
export function checkGraph(
  roots: readonly Class[],
  modules: readonly ProviderModule[],
  core: readonly Token[],
): void {
  const registrations = new Registrations(modules, coreOf(core), CONTAINER_DEFAULTS);
  const done = new Set<Token>();
  const visit = (cls: Class, chain: readonly string[], isUnderStore: boolean): void => {
    if (done.has(cls)) return;
    const path = [...chain, tokenName(cls)];
    if (chain.includes(tokenName(cls)))
      throw new ComponentError(`Dependency cycle: ${path.join(" → ")}`);
    const isStore = isUnderStore || infrastructureContractOf(cls) !== undefined;
    for (const dep of depsOf(cls)) {
      const found = registrationOf(registrations, dep, tokenName(cls), isStore);
      if (found.kind === "class") visit(found.cls, path, isStore);
    }
    done.add(cls);
  };
  roots.forEach((root) => {
    visit(root, [], false);
  });
}
