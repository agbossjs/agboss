/**
 * #88 AC1: required parameters without defaults — each mistake below is a compile error (`tsc` in
 * `make check`); an `@ts-expect-error` on a line that compiles would fail the build.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { Agent, DecidedBy } from "../../src/index.js";
import { ModelReranker, Rag, RagTenancy, Reranker } from "../../src/rag/index.js";
import type {
  RagRetrieval,
  RerankerClass,
  RerankOptions,
  RerankResult,
} from "../../src/rag/index.js";
import type { RagSearchResultDto } from "../../src/rag/index.js";
import { testConfig } from "../helpers.js";

// @ts-expect-error — k is required
@Rag({ name: "no_k", description: "d", tenancy: RagTenancy.PerTenant })
class NoK {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

// @ts-expect-error — #796: whose content it serves is declared, never assumed
@Rag({ name: "no_tenancy", description: "d", topK: 3 })
class NoTenancy {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

// @ts-expect-error — a knowledge base must implement retrieve
@Rag({ name: "no_retrieve", description: "d", topK: 3, tenancy: RagTenancy.Shared })
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
class DocsReranker extends ModelReranker {}

@Reranker({ name: "e-reranker", description: "d", decidedBy: DecidedBy.Code })
class OwnReranker {
  rerank(
    _query: string,
    candidates: readonly RagSearchResultDto[],
    { topK }: RerankOptions,
  ): Promise<RerankResult> {
    return Promise.resolve({ results: candidates.slice(0, topK) });
  }
}

@Agent({ name: "x-agent", description: "d", model: "m", prompt: "p" })
class AnAgent {}

class Plain {
  readonly label = "plain";
}

// no members: `extends Object` keeps it a class of no decorator, as empty as one can be
class Empty extends Object {}

/** A knowledge base reranked by `by`. */
const rerankedBy = (by: RerankerClass) => {
  @Rag({
    name: "reranked",
    description: "d",
    tenancy: RagTenancy.PerTenant,
    rerank: { by, candidates: 9, topK: 3 },
  })
  class Reranked {
    retrieve(): Promise<RagRetrieval> {
      return Promise.resolve({ results: [] });
    }
  }
  return Reranked;
};

// #818 AC3: rerank.by is a reranker class — a code one or a model one, nothing else
expectTypeOf(DocsReranker).toExtend<RerankerClass>();
expectTypeOf(OwnReranker).toExtend<RerankerClass>();
expectTypeOf(AnAgent).not.toExtend<RerankerClass>();
expectTypeOf(Plain).not.toExtend<RerankerClass>();
expectTypeOf(Empty).not.toExtend<RerankerClass>();
// @ts-expect-error — #818: an agent is no reranker
rerankedBy(AnAgent);
// @ts-expect-error — #818: a plain class is no reranker
rerankedBy(Plain);
// @ts-expect-error — #818: an empty class is no model reranker until it extends ModelReranker
rerankedBy(Empty);

// @ts-expect-error — #818: a model reranker extends ModelReranker
@Reranker({ name: "f-reranker", description: "d" })
class NotExtending {}

@Rag({
  name: "kept",
  description: "d",
  tenancy: RagTenancy.PerTenant,
  // @ts-expect-error — #818: the agent gets rerank.topK; keep is gone
  rerank: { by: DocsReranker, candidates: 9, keep: 3 },
})
class Kept {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

// @ts-expect-error — #703: topK and rerank are one number each, never both
@Rag({
  name: "both",
  description: "d",
  tenancy: RagTenancy.PerTenant,
  topK: 3,
  rerank: { by: DocsReranker, candidates: 9, topK: 3 },
})
class Both {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

// @ts-expect-error — #703: a model reranker takes no deps
@Reranker({ name: "b-reranker", description: "d", deps: [] })
class ModelWithDeps extends ModelReranker {}

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
    expect([
      NoK,
      NoTenancy,
      NoRetrieve,
      NoMode,
      Both,
      ModelWithDeps,
      CodeWithout,
      CodeWithModel,
      NotExtending,
      Kept,
      rerankedBy(DocsReranker),
      rerankedBy(OwnReranker),
    ]).toHaveLength(12);
  });
});
