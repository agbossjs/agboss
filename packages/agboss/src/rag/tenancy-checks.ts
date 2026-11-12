import { GraphRuleError, violation } from "../graph/rule-error.js";
import { RagTenancy } from "./types.js";

const TENANCIES: ReadonlySet<unknown> = new Set(Object.values(RagTenancy));

/**
 * `[rag.tenancy-required]` (#796): every knowledge base says whose content it serves — a JS
 * project or a cast may leave `tenancy` out, or give another value; all of them at once.
 */
export function checkTenancies(
  rags: readonly { readonly name: string; readonly tenancy: unknown }[],
): void {
  const found = rags.flatMap(({ name, tenancy }) => {
    if (TENANCIES.has(tenancy)) return [];
    const message = `${name}: declare whose content it serves — tenancy: RagTenancy.PerTenant (each tenant's own passages, read by options.tenantId) or RagTenancy.Shared (one corpus every tenant may read); got ${String(tenancy)}`;
    return [violation("rag.tenancy-required", message, [name])];
  });
  if (found.length > 0) throw new GraphRuleError({ violations: found });
}
