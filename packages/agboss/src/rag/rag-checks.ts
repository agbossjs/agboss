import type { Class } from "../components/injection.js";
import { requireComponent } from "../components/metadata.js";
import { checkRerankings } from "./rerank-checks.js";
import { checkTenancies } from "./tenancy-checks.js";

/**
 * A workflow's knowledge bases at assembly, loaded only when it binds one: each declares its
 * tenancy (#796, `[rag.tenancy-required]`), then each reranking is checked (#703).
 */
export function checkRags(rags: readonly Class[]): void {
  checkTenancies(rags.map((cls) => requireComponent(cls, "rag", "workflowOf").meta));
  if (rags.some((cls) => requireComponent(cls, "rag", "workflowOf").meta.rerank !== undefined))
    checkRerankings(rags);
}
