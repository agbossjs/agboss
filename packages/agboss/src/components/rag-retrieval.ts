import type { ModelCascade } from "../models/model-cascade.js";
import { retrieveOf, type RagRuntime } from "../rag/rag-source.js";
import type { KnowledgeRetrieval, RagScopeKey } from "../rag/types.js";
import type { BoundReranker } from "../rag/rerank.js";
import { lazyLoad } from "../infrastructure/clock.js";
import type { WorkflowServices } from "../workflow.js";
import type { Class } from "./injection.js";
import type { RagMeta } from "./rag.js";
import { boundRerankerOf } from "./rag-reranker.js";
import { scopeKeyOfRetrieval } from "./rag-scope.js";

/** The core's retrieval of a knowledge base: the scope's, reranked when it says so. */
export function knowledgeRetrieveOf(
  meta: RagMeta,
  source: object,
  reranker: BoundReranker | undefined,
  services: WorkflowServices,
): RagRuntime["retrieve"] {
  const fetchOf =
    (query: string, signal: AbortSignal, key: RagScopeKey, filter: unknown) => (topK: number) =>
      retrieveOf(source, query, {
        topK,
        signal,
        ...key,
        ...(filter === undefined ? {} : { filter }),
      });
  return async (query, { topK, signal, filter }): Promise<KnowledgeRetrieval> => {
    // the scope first: a call that cannot name its scope reads nothing, and a reranker is never reached
    const key = scopeKeyOfRetrieval(meta, source, services);
    const fetch = fetchOf(query, signal, key, filter);
    if (reranker === undefined) return fetch(topK);
    const { rerankedRetrieval } = await lazyLoad(import("../rag/rerank.js"));
    return rerankedRetrieval(fetch, reranker, {
      query,
      topK,
      ...key,
      signal,
    });
  };
}

/** What the container binds to a `@Rag` instance it creates: its name, `topK` and retrieval pipeline. */
export function buildRagRuntime(
  meta: RagMeta,
  source: object,
  instance: (cls: Class) => unknown,
  services: WorkflowServices,
  cascade: ModelCascade,
): RagRuntime {
  const reranker = boundRerankerOf(meta, instance, services, cascade);
  return {
    name: meta.name,
    topK: meta.topK,
    retrieve: knowledgeRetrieveOf(meta, source, reranker, services),
  };
}
