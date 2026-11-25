import { ConfigError } from "../core/error-families/config-errors.js";
import type { Class } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { RagScope } from "./types.js";

const SCOPES: ReadonlySet<unknown> = new Set(Object.values(RagScope));

/**
 * `[rag.scope-required]`: every knowledge base says whose content it serves — a JS project or a
 * cast may leave `scope` out, or give another value. `[rag.custom-scope-missing-resolver]`: a
 * `RagScope.Custom` source has `resolveScope(context)`. All of them at once.
 */
export function checkScopes(
  rags: readonly { readonly cls: Class; readonly name: string; readonly scope: unknown }[],
): void {
  const found = rags.flatMap(({ cls, name, scope }): RuleViolation[] => {
    if (!SCOPES.has(scope)) {
      const message = `${name}: declare whose content it serves — scope: RagScope.Shared (one corpus every tenant may read), RagScope.Tenant, RagScope.Owner or RagScope.Custom; got ${String(scope)}`;
      return [violation("rag.scope-required", message, [name])];
    }
    if (
      scope === RagScope.Custom &&
      typeof Reflect.get(cls.prototype as object, "resolveScope") !== "function"
    ) {
      const message = `${name}: scope RagScope.Custom needs resolveScope(context) on the class — it says which scope each call reads`;
      return [violation("rag.custom-scope-missing-resolver", message, [name])];
    }
    return [];
  });
  if (found.length > 0) throw new ConfigError.GraphRules({ violations: found });
}
