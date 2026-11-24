import type { Class } from "../components/injection.js";
import { requireComponent } from "../components/metadata.js";
import { checkRerankings } from "./rerank-checks.js";
import { checkScopes } from "./scope-checks.js";

/**
 * A workflow's knowledge bases at assembly, loaded only when it binds one: each declares its scope
 * (`[rag.scope-required]`, `[rag.custom-scope-missing-resolver]`), then each reranking is checked.
 */
export function checkRags(rags: readonly Class[]): void {
  checkScopes(
    rags.map((cls) => {
      const { name, scope } = requireComponent(cls, "rag", "workflowOf").meta;
      return { cls, name, scope };
    }),
  );
  if (rags.some((cls) => requireComponent(cls, "rag", "workflowOf").meta.reranker !== undefined))
    checkRerankings(rags);
}
