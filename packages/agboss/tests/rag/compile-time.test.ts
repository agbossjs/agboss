/**
 * #88 AC1: required parameters without defaults — each mistake below is a compile error (`tsc` in
 * `make check`); an `@ts-expect-error` on a line that compiles would fail the build.
 */
import { describe, expect, it } from "vitest";
import { Agent, DecidedBy } from "../../src/index.js";
import { Rag, Reranker } from "../../src/rag/index.js";
import type { RagRetrieval } from "../../src/rag/index.js";
import { testConfig } from "../helpers.js";

// @ts-expect-error — k is required
@Rag({ name: "no_k", description: "d" })
class NoK {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

// @ts-expect-error — a knowledge base must implement retrieve
@Rag({ name: "no_retrieve", description: "d", topK: 3 })
class NoRetrieve {
  search(): string {
    return "";
  }
}

@Agent({
  name: "a",
  description: "d",
  model: "m",
  price: testConfig.agents.alpha.price,
  // @ts-expect-error — mode is required
  rag: [{ use: NoK }],
  prompt: "./x.md",
})
class NoMode {}

@Reranker({ name: "a-reranker", description: "d" })
class ModelReranker {}

// @ts-expect-error — #703: topK and rerank are one number each, never both
@Rag({
  name: "both",
  description: "d",
  topK: 3,
  rerank: { by: ModelReranker, candidates: 9, keep: 3 },
})
class Both {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

// @ts-expect-error — #703: a model reranker takes no deps
@Reranker({ name: "b-reranker", description: "d", deps: [] })
class ModelWithDeps {}

// @ts-expect-error — #703: a code reranker implements rerank()
@Reranker({ name: "c-reranker", description: "d", decidedBy: DecidedBy.Code })
class CodeWithout {}

// @ts-expect-error — #703: a code reranker has no model
@Reranker({ name: "d-reranker", description: "d", decidedBy: DecidedBy.Code, model: "m" })
class CodeWithModel {
  rerank(): Promise<{ results: [] }> {
    return Promise.resolve({ results: [] });
  }
}

describe("knowledge bases — compile-time checks", () => {
  it("AC1: the file above type-checks only because each mistake is a compile error", () => {
    expect([NoK, NoRetrieve, NoMode, Both, ModelWithDeps, CodeWithout, CodeWithModel]).toHaveLength(
      7,
    );
  });
});
