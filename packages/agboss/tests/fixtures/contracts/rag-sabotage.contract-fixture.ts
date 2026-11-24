// #700 AC2 — the RAG source contract run on a sound in-memory connector and on one broken way
// per rule; tests/testing/contracts/rag-sabotage.test.ts reads which cases each fails.
import { RagScope } from "../../../src/rag/types.js";
import { ragSourceContract } from "../../../src/testing/contracts/index.js";
import { memoryTarget } from "./rag-sources.js";

ragSourceContract(memoryTarget("sound"));
ragSourceContract(memoryTarget("ignores the tenant", { keyOf: () => "everyone" }));
ragSourceContract(
  memoryTarget("folds the tenant id", {
    keyOf: (scopeId) => scopeId.normalize("NFKC").toLowerCase(),
  }),
);
ragSourceContract(memoryTarget("appends on re-index", { appendsOnReindex: true }));
ragSourceContract(memoryTarget("ignores topK", { ignoresTopK: true }));
ragSourceContract(memoryTarget("ignores the signal", { ignoresSignal: true }));
ragSourceContract(memoryTarget("reports NaN", { costUsd: Number.NaN }));
// #703 AC5: a reranker in place does not hide a source that ignores the tenant
ragSourceContract({
  ...memoryTarget("ignores the tenant, reranked", { keyOf: () => "everyone" }),
  rerank: {
    by: {
      rerank: (_q, candidates, { topK }) => ({ results: candidates.slice(0, topK) }),
    },
    candidates: 10,
  },
});
// #799 AC2: the contract reranks under FailStep — a sound reranker passes every case, and one that
// fails quietly (a throw, a passage that is no candidate) fails the cases that retrieve, never
// falling back to the retrieval's own order
const reranked = (name: string, by: Parameters<typeof ragSourceContract>[0]["rerank"]): void => {
  ragSourceContract({ ...memoryTarget(name), rerank: by });
};
reranked("sound, reranked", {
  by: {
    rerank: (_q, candidates, { topK }) => ({ results: [...candidates].reverse().slice(0, topK) }),
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
// #818 AC5: a shared corpus — a source that serves every tenant one corpus passes the Shared
// cases (reranked too); one that keys by scope, declared Shared, fails them
const shared = (name: string, flaws: Parameters<typeof memoryTarget>[1] = {}) => ({
  ...memoryTarget(name, flaws),
  scope: RagScope.Shared,
});
ragSourceContract(shared("shared", { keyOf: () => "everyone" }));
ragSourceContract({
  ...shared("shared, reranked", { keyOf: () => "everyone" }),
  rerank: {
    by: {
      rerank: (_q, candidates, { topK }) => ({ results: [...candidates].reverse().slice(0, topK) }),
    },
    candidates: 10,
  },
});
ragSourceContract(shared("shared, keyed by tenant"));
// (a copy per tenant cannot happen to a shared source any more: the core hands it no scope id)
