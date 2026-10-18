import { tokenName, type Class, type Token } from "../injection.js";
import { ComponentError } from "../metadata.js";
import { depsOf } from "./container.js";
import { Registrations, type ProviderModule } from "./registrations.js";
import { INFRASTRUCTURE_DEFAULTS } from "../../infrastructure/contracts.js";
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
 * Checks the dependency graph of `roots` without creating anything: every dependency registered (a
 * contract by one implementation, an infrastructure contract else by its built-in default), no
 * cycles, no conflicting values. Errors name the component and the chain.
 */
export function checkGraph(
  roots: readonly Class[],
  modules: readonly ProviderModule[],
  core: readonly Token[],
): void {
  const registrations = new Registrations(modules, coreOf(core), INFRASTRUCTURE_DEFAULTS);
  const done = new Set<Token>();
  const visit = (cls: Class, chain: readonly string[]): void => {
    if (done.has(cls)) return;
    const path = [...chain, tokenName(cls)];
    if (chain.includes(tokenName(cls)))
      throw new ComponentError(`Dependency cycle: ${path.join(" → ")}`);
    for (const dep of depsOf(cls)) {
      const found = registrations.find(dep, tokenName(cls));
      if (found === undefined) {
        throw (
          undeclaredContextError(dep, tokenName(cls)) ??
          new ComponentError(
            `${tokenName(cls)}: "${tokenName(dep)}" is not registered in @Workflow({ providers })`,
          )
        );
      }
      if (found.kind === "class") visit(found.cls, path);
    }
    done.add(cls);
  };
  roots.forEach((root) => {
    visit(root, []);
  });
}
