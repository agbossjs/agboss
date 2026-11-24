import { afterEach, describe, it } from "vitest";
import { rerankedRetrieval } from "../../rag/rerank.js";
import { indexOf, retrieveOf } from "../../rag/rag-source.js";
import { RagScope, RerankFailurePolicy } from "../../rag/types.js";
import { RAG_SOURCE_CASES } from "./rag-source.cases.js";
import {
  liveSignal,
  type ContractRetrieve,
  type ContractReranker,
  type ContractSource,
  type ObservedRagCall,
  type RagCaseContext,
  type RagSourceContractTarget,
} from "./rag-source-data.js";

/**
 * `ragSourceContract(target)`: the rules every knowledge base source keeps, as the core's reference
 * `SqliteFtsRagSource` runs them — registered as `RAG source contract (<name>)`, each case on a
 * fresh source: scope isolation (near-identical ids too), re-indexing that replaces, `topK`, the
 * abort signal, a cost the ledger can add, well-formed results. With `rerank: { by }` every
 * retrieval goes through that reranker under `RerankFailurePolicy.FailStep`: one that throws or
 * returns a passage that is no candidate fails the case.
 *
 * `scope: RagScope.Shared` is a source of one corpus every reader sees: in place of the isolation
 * cases, every asker — near-identical ids too — gets the same results, a re-index replaces the
 * corpus for every asker that read it, and no call to the source carries a scope id (through the
 * core's reranking too); the other cases run for both. The core passing the execution's scope to a
 * source is the core's own test (`tests/rag/scope.test.ts`).
 *
 * `ragSourceContract({ name: "pgvector", source: () => new MyRag(pool), documents: (s, scopeId, docs) => seed(scopeId, docs), reset: truncate })`
 */
export function ragSourceContract<TSource extends object>(
  target: RagSourceContractTarget<TSource>,
): void {
  const scope = target.scope ?? RagScope.Tenant;
  // a JS caller's or a cast's other value would select no case: an empty suite reads as a pass
  if (!Object.values(RagScope).includes(scope))
    throw new TypeError(
      `ragSourceContract(${target.name}): scope is RagScope.Shared, Tenant, Owner or Custom, not ${scope}`,
    );
  describe(`RAG source contract (${target.name})`, () => {
    if (target.reset !== undefined) afterEach(target.reset);
    for (const contractCase of RAG_SOURCE_CASES) {
      if (!contractCase.scopes.includes(scope)) continue;
      it(contractCase.name, async () => {
        await contractCase.run(await contextOf(target, scope));
      });
    }
  });
}

/** A case's source, how it is filled, and how it is asked — each call it receives observed. */
async function contextOf<TSource extends object>(
  target: RagSourceContractTarget<TSource>,
  scope: RagScope,
): Promise<RagCaseContext> {
  const own = await target.source();
  const calls: ObservedRagCall[] = [];
  const source = observedSource(own, scope, calls);
  const fill: RagCaseContext["fill"] = async (scopeId, documents) => {
    await target.documents(own, scopeId, documents);
    await source.index?.({ ...scopeOf(scope, scopeId), signal: liveSignal() });
  };
  return { source, calls, fill, retrieve: retrieveThrough(target, source, scope, calls) };
}

/** The scope id a call carries: none to a shared source, whoever asks. */
const scopeOf = (
  scope: RagScope,
  scopeId: string,
): { readonly tenantId?: string; readonly scopeId?: string } =>
  scope === RagScope.Shared ? {} : { tenantId: scopeId, scopeId };

/** The source as the suite calls it: the same calls, each one's scope id recorded first. */
function observedSource(own: object, scope: RagScope, calls: ObservedRagCall[]): ContractSource {
  /** What the core hands the source: none of the scope for a shared one; a tenant's scope names its tenant. */
  const carried = <T extends { readonly tenantId?: string; readonly scopeId?: string }>(
    options: T,
  ): T => {
    const rest = Object.fromEntries(
      Object.entries(options).filter(([key]) => key !== "tenantId" && key !== "scopeId"),
    );
    if (scope === RagScope.Shared) return rest as T;
    const id = options.scopeId ?? options.tenantId;
    return id === undefined
      ? (rest as T)
      : ({ ...rest, tenantId: options.tenantId ?? id, scopeId: id } as T);
  };
  const retrieve: ContractSource["retrieve"] = (query, options) => {
    const given = carried(options);
    calls.push({ call: "retrieve", scopeId: given.scopeId });
    return retrieveOf(own, query, given);
  };
  const index: ContractSource["index"] = async (options) => {
    const given = carried(options);
    calls.push({ call: "index", scopeId: given.scopeId });
    const report = await indexOf(own, given);
    if (report === undefined) throw new TypeError("the source has no index");
    return report;
  };
  return { retrieve, ...(hasIndex(own) ? { index } : {}) };
}

const hasIndex = (own: object): boolean => typeof Reflect.get(own, "index") === "function";

/** The reranker as the suite's reranking calls it, each call's scope id recorded first. */
const observedReranker = (by: ContractReranker, calls: ObservedRagCall[]): ContractReranker => ({
  rerank: (query, candidates, options) => {
    calls.push({ call: "rerank", scopeId: options.scopeId });
    return by.rerank(query, candidates, options);
  },
});

/** A case's retrieval: the source's own, or through the core's reranking. */
function retrieveThrough<TSource extends object>(
  target: RagSourceContractTarget<TSource>,
  source: ContractSource,
  scope: RagScope,
  calls: ObservedRagCall[],
): ContractRetrieve {
  const { rerank } = target;
  if (rerank === undefined)
    return (query, { topK, scopeId, signal }) =>
      source.retrieve(query, { topK, signal, ...scopeOf(scope, scopeId) });
  const bound = {
    rag: target.name,
    reranker: "contract-reranker",
    candidates: rerank.candidates,
    // a failing reranker fails the case — a fallback to the retrieval's order would pass it
    onFailure: RerankFailurePolicy.FailStep,
    source: { kind: "code", instance: () => observedReranker(rerank.by, calls) },
  } as const;
  return (query, { topK, scopeId, signal }) => {
    const carried = scopeOf(scope, scopeId);
    return rerankedRetrieval(
      (k) => source.retrieve(query, { topK: k, signal, ...carried }),
      bound,
      {
        query,
        topK,
        signal,
        ...carried,
      },
    );
  };
}
