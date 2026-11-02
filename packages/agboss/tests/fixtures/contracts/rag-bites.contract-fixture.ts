// #700 AC2 — the RAG connector contract run on a sound in-memory connector and on one broken way
// per rule; tests/testing/contracts/rag-bites.test.ts reads which cases each fails.
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
