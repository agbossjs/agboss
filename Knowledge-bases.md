# Knowledge bases (RAG)

The core fixes a **contract**, not a technology: a knowledge base is any class implementing
`RagConnector` — embeddings or full-text, local or an API, SQLite or a vector DB. The core wires it
to agents, reports its cost and traces it. Decision: [ADR-0010](ADR-0010-RAG-as-a-contract).

<!-- snippet-context
import type { IndexReport } from "@agboss/core/rag";
import type { RagSearchResultDto } from "@agboss/core/dto";
-->

```ts
interface RagConnector {
  retrieve(query: string, options: { topK: number; signal: AbortSignal }): Promise<RagRetrieval>;
  index?(): Promise<IndexReport>; // optional: build / update the index
}
interface RagRetrieval {
  results: readonly RagSearchResultDto[]; // { text, source, score? } (agboss/dto)
  costUsd?: number;
}
// `source` is what the answer cites as [source]
```

## A knowledge base

The reference connector, extended — its options come through the constructor as a token:

```ts file=rag/company-docs.rag.ts
import { InjectionToken } from "@agboss/core";
import { Rag, SqliteFtsConnector, type FtsOptions } from "@agboss/core/rag";

export const DOCS_INDEX = new InjectionToken<FtsOptions>("DOCS_INDEX");

// `topK` (search results per retrieval) is required; there is no default
@Rag({
  name: "company_docs",
  description: "Nimbus Labs docs: onboarding, product, team",
  topK: 4,
  deps: [DOCS_INDEX],
})
export class CompanyDocs extends SqliteFtsConnector {}
```

Or your own implementation of the contract:

```ts
import { Rag, type RagConnector, type RagRetrieval } from "@agboss/core/rag";

@Rag({ name: "faq", description: "Answers to frequent questions", topK: 3 })
export class Faq implements RagConnector {
  private readonly entries = [{ text: "Refunds take 5 days.", source: "faq.md#refunds" }];

  retrieve(query: string, options: { readonly topK: number }): Promise<RagRetrieval> {
    const words = query.toLowerCase().split(/\s+/);
    const hits = this.entries.filter((entry) => words.some((word) => entry.text.toLowerCase().includes(word)));
    return Promise.resolve({ results: hits.slice(0, options.topK) });
  }
}
```

Dependencies come through the constructor, like any [component](Components); register the token's
value in the workflow's `providers` (`provide(DOCS_INDEX, { folder: "docs", dbFile: "docs.sqlite" })`).
Swap the implementation in this one file — nothing else changes.

## Binding — `mode` is required

<!-- snippet-context
import { Agent, RagMode } from "@agboss/core";
import { CompanyDocs } from "./rag/company-docs.rag.js";
-->

```ts
@Agent({
  name: "onboarding-agent",
  description: "Answers questions about the company",
  prompt: "Answer from the company docs; cite them as [source].",
  model: "moonshotai/kimi-k2.6",
  rag: [{ use: CompanyDocs, mode: RagMode.Tool }], // the agent calls search-company-docs-tool(query)
  // rag: [{ use: CompanyDocs, mode: RagMode.Context }] — the core puts the top results in its input message
})
export class OnboardingAgent {}
```

| Mode      | What happens                                                                                     | On error                         |
| --------- | -------------------------------------------------------------------------------------------------- | --------------------------------- |
| `RagMode.Tool`    | a read tool `search-<name>-tool` returning `{ results }`; the agent decides when and what to search  | returned to the model (any tool) |
| `RagMode.Context` | before the agent's loop the core retrieves `topK` results for its input message, appended to it as `Knowledge (<name>):` | the turn goes on without them    |

Both modes ask the model to cite `[source]`. Omitting `topK`, `mode` or `retrieve` is a compile error.

## Costs and traces

Retrieval is billed to `rag:<name>` — FinOps category **`retrieval`**; context retrieval is a named
span `rag:<name>` in Langfuse, tool mode is traced as a tool.

## Index

```bash
npm run rag:index      # agboss rag index — every knowledge base of the application [--rag company_docs]
# company_docs: 3 documents, 5 chunks, 0 unchanged · $0.000000
```

## The reference implementation — `SqliteFtsConnector`

SQLite FTS5 (built into Node's `node:sqlite`), ranked by BM25 — no dependencies, no cost. `index()`
splits Markdown at headings and paragraphs (≤ 800 characters) and skips files whose content hash did
not change; the index is built on first use when it is empty. It finds words, not meanings (no
synonyms): for semantic search write another connector (e.g. `sqlite-vec` + an embeddings model).

`npm run describe` shows each agent's bases: `rag: company_docs (tool, k 4)`.
