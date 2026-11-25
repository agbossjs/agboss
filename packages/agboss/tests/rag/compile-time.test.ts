/**
 * Required parameters without defaults — each mistake below is a compile error (`tsc` in
 * `make check`); an `@ts-expect-error` on a line that compiles would fail the build. The removed
 * forms (`tenancy`, `rerank`, `mode`, `RagConnector`, `@Reranker`) are pinned too.
 */
import { StepError } from "../../src/core/error-families/step-errors.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Agent, Tool } from "../../src/index.js";
import {
  Rag,
  RagQueryDto,
  RagReranker,
  RagScope,
  RagSearchResultsDto,
  RagSource,
  type RagRetrieval,
  type RagRetrieveOptions,
  type RagSearchOptions,
  type RerankOptions,
  type RerankResult,
} from "../../src/rag/index.js";
import type { RagSearchResultDto } from "../../src/rag/index.js";
import * as rag from "../../src/rag/index.js";
import { testConfig } from "../helpers.js";

class Plain extends RagSource {
  protected override retrieve(): RagRetrieval {
    return { results: [] };
  }
}

// @ts-expect-error — topK is required
@Rag({ name: "no_k", description: "d", scope: RagScope.Tenant })
class NoK extends Plain {}

// @ts-expect-error — whose content it serves is declared, never assumed
@Rag({ name: "no_scope", description: "d", topK: 3 })
class NoScope extends Plain {}

// @ts-expect-error — a knowledge base extends RagSource
@Rag({ name: "no_source", description: "d", topK: 3, scope: RagScope.Shared })
class NoSource {
  retrieve(): RagRetrieval {
    return { results: [] };
  }
}

// @ts-expect-error — `tenancy` is gone: it is `scope`
@Rag({ name: "old_tenancy", description: "d", topK: 3, scope: RagScope.Shared, tenancy: "shared" })
class OldTenancy extends Plain {}

@Rag({
  name: "old_rerank",
  description: "d",
  topK: 3,
  scope: RagScope.Shared,
  // @ts-expect-error — `rerank: { by, candidates, topK }` is gone: `reranker` is a @RagReranker class
  rerank: { by: Plain, candidates: 9, topK: 3 },
})
class OldRerank extends Plain {}

@RagReranker({ name: "a-reranker", description: "d", candidates: 9 })
class DocsReranker {}

@RagReranker({ name: "e-reranker", description: "d", candidates: 9 })
class OwnReranker {
  rerank(
    _query: string,
    candidates: readonly RagSearchResultDto[],
    { topK }: RerankOptions,
  ): RerankResult {
    return { results: candidates.slice(0, topK) };
  }
}

// @ts-expect-error — candidates is required: it is what the reranker is asked to rerank
@RagReranker({ name: "b-reranker", description: "d" })
class NoCandidates {}

@Rag({
  name: "reranked",
  description: "d",
  topK: 3,
  scope: RagScope.Tenant,
  reranker: DocsReranker,
})
class Reranked extends Plain {}

@Agent({
  name: "a",
  description: "d",
  model: "m",
  rag: [Reranked, NoK],
  prompt: "./x.md",
})
class Reads {}

@Agent({
  name: "b",
  description: "d",
  model: "m",
  // @ts-expect-error — `{ use, mode }` is gone: `rag` is a list of classes
  rag: [{ use: NoK, mode: "tool" }],
  prompt: "./x.md",
})
class OldBinding {}

/** A search tool over a knowledge base: the ready-made DTOs fit. */
@Tool({
  name: "search-docs",
  description: "d",
  input: RagQueryDto,
  output: RagSearchResultsDto,
  readOnly: true,
  deps: [Reranked],
})
class SearchDocs {
  constructor(private readonly docs: Reranked) {}

  execute({ query }: RagQueryDto) {
    return this.docs.search(query);
  }
}

// `search` takes the call's topK and filter; a source that declares no filter takes none
expectTypeOf<Parameters<Plain["search"]>[1]>().toEqualTypeOf<RagSearchOptions | undefined>();
expectTypeOf<RagSearchOptions<{ readonly lang: string }>["filter"]>().toEqualTypeOf<
  { readonly lang: string } | undefined
>();
expectTypeOf<Awaited<ReturnType<Plain["search"]>>>().toEqualTypeOf<RagSearchResultsDto>();
expectTypeOf<RagRetrieveOptions["scopeId"]>().toEqualTypeOf<string | undefined>();
// `retrieve` is protected: the pipeline is the only way in
expectTypeOf<"retrieve" extends keyof Plain ? true : false>().toEqualTypeOf<false>();
expectTypeOf<"index" extends keyof Plain ? true : false>().toEqualTypeOf<false>();

// the removed names are gone from the entry, at compile time and at run time
expectTypeOf(rag).not.toHaveProperty("RagTenancy");
expectTypeOf(rag).not.toHaveProperty("RagMode");
expectTypeOf(rag).not.toHaveProperty("Reranker");
expectTypeOf(rag).not.toHaveProperty("ModelReranker");
expectTypeOf(rag).not.toHaveProperty("DecidedBy");
expectTypeOf(rag).not.toHaveProperty("SqliteFtsConnector");
expectTypeOf(rag).not.toHaveProperty("DEFAULT_RERANKER_MODEL");

describe("knowledge bases — compile-time checks", () => {
  it("the removed names are not exported at run time either", () => {
    for (const name of [
      "RagTenancy",
      "RagMode",
      "Reranker",
      "ModelReranker",
      "DecidedBy",
      "SqliteFtsConnector",
      "DEFAULT_RERANKER_MODEL",
      "StepError.RerankFailed",
      "RagFts5UnavailableError",
      "RagIndexVersionError",
    ])
      expect(Reflect.has(rag, name), name).toBe(false);
  });

  it("the file above type-checks only because each mistake is a compile error", () => {
    expect([
      NoK,
      NoScope,
      NoSource,
      OldTenancy,
      OldRerank,
      NoCandidates,
      OldBinding,
      Reads,
      SearchDocs,
      OwnReranker,
    ]).toHaveLength(10);
  });
});
