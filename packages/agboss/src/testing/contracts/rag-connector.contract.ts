import { afterEach, describe, it } from "vitest";
import { rerankedRetrieval } from "../../rag/rerank.js";
import {
  RagTenancy,
  RerankFailurePolicy,
  type RagConnector,
  type RerankerHandler,
} from "../../rag/types.js";
import { RAG_CONNECTOR_CASES } from "./rag-connector.cases.js";
import {
  liveSignal,
  type ContractRetrieve,
  type ObservedRagCall,
  type RagCaseContext,
  type RagConnectorContractTarget,
} from "./rag-connector-data.js";

/**
 * `ragConnectorContract(target)` (#700): the rules every knowledge base connector keeps, as the
 * core's reference `SqliteFtsConnector` runs them — registered as `RAG connector contract (<name>)`,
 * each case on a fresh connector: tenant isolation (near-identical ids too), re-indexing that
 * replaces, `topK`, the abort signal, a cost the ledger can add, well-formed results. With
 * `rerank: { by }` every retrieval goes through that reranker under `RerankFailurePolicy.FailStep`
 * (#799): one that throws or returns a passage that is no candidate fails the case.
 *
 * `tenancy: RagTenancy.Shared` (#818) is a connector of one corpus every tenant reads: in place of
 * the isolation cases, every tenant — near-identical ids too — gets the same results, a re-index
 * replaces the corpus, and every call still reaches the connector (and the reranker) with the tenant
 * it is made for, as the core passes it; the other cases run for both.
 *
 * `ragConnectorContract({ name: "pgvector", connector: () => new MyConnector(pool), documents: (c, tenantId, docs) => seed(tenantId, docs), reset: truncate })`
 */
export function ragConnectorContract<TConnector extends RagConnector>(
  target: RagConnectorContractTarget<TConnector>,
): void {
  const tenancy = target.tenancy ?? RagTenancy.PerTenant;
  describe(`RAG connector contract (${target.name})`, () => {
    if (target.reset !== undefined) afterEach(target.reset);
    for (const contractCase of RAG_CONNECTOR_CASES) {
      if (!contractCase.tenancies.includes(tenancy)) continue;
      it(contractCase.name, async () => {
        await contractCase.run(await contextOf(target));
      });
    }
  });
}

/** A case's connector, how it is filled, and how it is asked — each call it receives observed. */
async function contextOf<TConnector extends RagConnector>(
  target: RagConnectorContractTarget<TConnector>,
): Promise<RagCaseContext> {
  const own = await target.connector();
  const calls: ObservedRagCall[] = [];
  const connector = observedConnector(own, calls);
  const fill: RagCaseContext["fill"] = async (tenantId, documents) => {
    await target.documents(own, tenantId, documents);
    await connector.index?.({ tenantId, signal: liveSignal() });
  };
  return { connector, calls, fill, retrieve: retrieveOf(target, connector, calls) };
}

/** The connector as the suite calls it: the same calls, each one's tenant recorded first (#818). */
function observedConnector(connector: RagConnector, calls: ObservedRagCall[]): RagConnector {
  const retrieve: RagConnector["retrieve"] = (query, options) => {
    calls.push({ call: "retrieve", tenantId: options.tenantId });
    return connector.retrieve(query, options);
  };
  const { index } = connector;
  if (index === undefined) return { retrieve };
  return {
    retrieve,
    index: (options) => {
      calls.push({ call: "index", tenantId: options.tenantId });
      return index.call(connector, options);
    },
  };
}

/** The reranker as the suite's reranking calls it, each call's tenant recorded first (#818). */
const observedReranker = (by: RerankerHandler, calls: ObservedRagCall[]): RerankerHandler => ({
  rerank: (query, candidates, options) => {
    calls.push({ call: "rerank", tenantId: options.tenantId });
    return by.rerank(query, candidates, options);
  },
});

/** A case's retrieval: the connector's own, or through the core's reranking (#703). */
function retrieveOf<TConnector extends RagConnector>(
  target: RagConnectorContractTarget<TConnector>,
  connector: RagConnector,
  calls: ObservedRagCall[],
): ContractRetrieve {
  const { rerank } = target;
  if (rerank === undefined) return (query, options) => connector.retrieve(query, options);
  const bound = {
    rag: target.name,
    reranker: "contract-reranker",
    candidates: rerank.candidates,
    // #799: a failing reranker fails the case — a fallback to the retrieval's order would pass it
    onFailure: RerankFailurePolicy.FailStep,
    source: { kind: "code", instance: () => observedReranker(rerank.by, calls) },
  } as const;
  return (query, { topK, tenantId, signal }) =>
    rerankedRetrieval((k) => connector.retrieve(query, { topK: k, tenantId, signal }), bound, {
      query,
      topK,
      tenantId,
      signal,
    });
}
