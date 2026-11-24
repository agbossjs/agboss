import { usd } from "../../src/units/index.js";
/**
 * #700 AC2 — the reference connector runs the published RAG connector contract
 * (`ragSourceContract`, `@agboss/core/testing/contracts`): each tenant its own folder (looked up,
 * never built from the id), one index file.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteFtsRagSource } from "../../src/rag/sqlite-fts.js";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { afterAll, expect } from "vitest";
import { modelRerankerOf } from "../../src/rag/llm-reranker.js";
import type { RerankResult, RerankerHandler } from "../../src/rag/types.js";
import {
  ragSourceContract,
  type RagSourceContractTarget,
} from "../../src/testing/contracts/index.js";

/** The connector of one case and its tenants' folders. */
const folders = new WeakMap<SqliteFtsRagSource, Map<string, string>>();
const roots = new WeakMap<SqliteFtsRagSource, string>();

/** The target of one case's connector: each tenant its own folder, one index file. */
const target = {
  name: "SqliteFtsRagSource",
  source: async () => {
    const root = await mkdtemp(join(tmpdir(), "fts-contract-"));
    const byTenant = new Map<string, string>();
    const connector = new SqliteFtsRagSource({
      directory: (scopeId) => (scopeId === undefined ? undefined : byTenant.get(scopeId)),
      path: join(root, "index.sqlite"),
    });
    folders.set(connector, byTenant);
    roots.set(connector, root);
    return connector;
  },
  documents: async (connector, scopeId, documents) => {
    const byTenant = folders.get(connector) ?? new Map<string, string>();
    const folder =
      byTenant.get(scopeId) ?? join(roots.get(connector) ?? tmpdir(), `t${String(byTenant.size)}`);
    byTenant.set(scopeId, folder);
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { recursive: true });
    for (const document of documents) await writeFile(join(folder, document.source), document.text);
  },
} satisfies RagSourceContractTarget<SqliteFtsRagSource>;

ragSourceContract(target);

/**
 * #703 AC5 — the same cases through the core's reranking: the LLM reranker on a model that always
 * ranks the second and first candidates first, and a code reranker that reverses them.
 */
const model = modelRerankerOf("docs-reranker", {
  model: new FakeListChatModel({ responses: ['{"ranking":[2,1]}'] }),
  settings: {
    model: "test/reranker",
    temperature: 0,
    maxTokens: 256,
    price: { inputPerMTok: 1, outputPerMTok: 2 },
  },
});
/** The LLM reranker, counted: every case must rerank through it, none fall back. */
const counts = { reranked: 0, failed: 0 };
const llm: RerankerHandler = {
  rerank: async (query, candidates, options) => {
    try {
      const reranking = await model.rerank(query, candidates, options);
      counts.reranked += 1;
      return reranking;
    } catch (error) {
      counts.failed += 1;
      throw error;
    }
  },
};
afterAll(() => {
  expect(counts).toMatchObject({ failed: 0 });
  expect(counts.reranked).toBeGreaterThan(0);
});

const reversing: RerankerHandler = {
  rerank: (_query, candidates, { topK }): Promise<RerankResult> =>
    Promise.resolve({ results: [...candidates].reverse().slice(0, topK), costUsd: usd(0) }),
};

ragSourceContract({
  ...target,
  name: "SqliteFtsRagSource + LLM reranker",
  rerank: { by: llm, candidates: 20 },
});
ragSourceContract({
  ...target,
  name: "SqliteFtsRagSource + code reranker",
  rerank: { by: reversing, candidates: 20 },
});
