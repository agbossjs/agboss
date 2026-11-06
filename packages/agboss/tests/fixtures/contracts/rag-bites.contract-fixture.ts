// #700 AC2 — the RAG connector contract run on a sound in-memory connector and on one broken way
// per rule; tests/testing/contracts/rag-bites.test.ts reads which cases each fails.
import { RagTenancy } from "../../../src/rag/types.js";
import { ragConnectorContract } from "../../../src/testing/contracts/index.js";
import { memoryTarget } from "./rag-connectors.js";

ragConnectorContract(memoryTarget("sound"));
ragConnectorContract(memoryTarget("ignores the tenant", { keyOf: () => "everyone" }));
ragConnectorContract(
  memoryTarget("folds the tenant id", {
    keyOf: (tenantId) => tenantId.normalize("NFKC").toLowerCase(),
  }),
);
ragConnectorContract(memoryTarget("appends on re-index", { appendsOnReindex: true }));
ragConnectorContract(memoryTarget("ignores topK", { ignoresTopK: true }));
ragConnectorContract(memoryTarget("ignores the signal", { ignoresSignal: true }));
ragConnectorContract(memoryTarget("reports NaN", { costUsd: Number.NaN }));
// #703 AC5: a reranker in place does not hide a connector that ignores the tenant
ragConnectorContract({
  ...memoryTarget("ignores the tenant, reranked", { keyOf: () => "everyone" }),
  rerank: {
    by: {
      rerank: (_q, candidates, { topK }) => Promise.resolve({ results: candidates.slice(0, topK) }),
    },
    candidates: 10,
  },
});
// #799 AC2: the contract reranks under FailStep — a sound reranker passes every case, and one that
// fails quietly (a throw, a passage that is no candidate) fails the cases that retrieve, never
// falling back to the retrieval's own order
const reranked = (name: string, by: Parameters<typeof ragConnectorContract>[0]["rerank"]): void => {
  ragConnectorContract({ ...memoryTarget(name), rerank: by });
};
reranked("sound, reranked", {
  by: {
    rerank: (_q, candidates, { topK }) =>
      Promise.resolve({ results: [...candidates].reverse().slice(0, topK) }),
  },
  candidates: 10,
});
reranked("a reranker that throws", {
  by: { rerank: () => Promise.reject(new Error("reranker down")) },
  candidates: 10,
});
reranked("a reranker that returns no candidate", {
  by: {
    rerank: (_q, candidates) =>
      Promise.resolve({
        results: candidates
          .slice(0, 1)
          .map((one) => ({ text: one.text, source: `${one.source}#forged`, score: one.score })),
      }),
  },
  candidates: 10,
});
// #818 AC5: a shared corpus — a connector that serves every tenant one corpus passes the Shared
// cases (reranked too); one that keys by tenant, declared Shared, fails them
const shared = (name: string, flaws: Parameters<typeof memoryTarget>[1] = {}) => ({
  ...memoryTarget(name, flaws),
  tenancy: RagTenancy.Shared,
});
ragConnectorContract(shared("shared", { keyOf: () => "everyone" }));
ragConnectorContract({
  ...shared("shared, reranked", { keyOf: () => "everyone" }),
  rerank: {
    by: {
      rerank: (_q, candidates, { topK }) =>
        Promise.resolve({ results: [...candidates].reverse().slice(0, topK) }),
    },
    candidates: 10,
  },
});
ragConnectorContract(shared("shared, keyed by tenant"));
