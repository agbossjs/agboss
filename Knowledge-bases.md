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
  retrieve(query: string, options: { topK: number; signal: AbortSignal; tenantId: string }): Promise<RagRetrieval>;
  index?(options: { tenantId: string; signal: AbortSignal }): Promise<IndexReport>; // optional: build / update one tenant's index
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

Or your own implementation of the contract — every call carries the execution's tenant, and it
returns that tenant's passages only ([Tenants](#tenants)):

```ts
import { Rag, type RagConnector, type RagRetrieval, type RagRetrieveOptions } from "@agboss/core/rag";

@Rag({ name: "faq", description: "Answers to frequent questions", topK: 3 })
export class Faq implements RagConnector {
  private readonly entriesByTenant = new Map([
    ["default", [{ text: "Refunds take 5 days.", source: "faq.md#refunds" }]],
  ]);

  retrieve(query: string, options: RagRetrieveOptions): Promise<RagRetrieval> {
    const words = query.toLowerCase().split(/\s+/);
    const entries = this.entriesByTenant.get(options.tenantId) ?? [];
    const hits = entries.filter((entry) => words.some((word) => entry.text.toLowerCase().includes(word)));
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

## Tenants

A knowledge base is tenant-scoped (#700), like every store of AGBoss. The core passes the
execution's tenant on every retrieval — tool mode and context mode alike — and every index build:
`options.tenantId`, read from the frame of the step or tool call that runs it. A connector returns
only that tenant's passages and indexes into that tenant only, and compares the id **as given** —
`acme`, `Acme`, `ａｃｍｅ`, `café` and `cafe` are five tenants. Content every tenant may read (a
public help center) is the connector's choice: it returns the same passages whoever asks.

- The id is a key's text ([Several instances](Several-instances), #552): one that breaks a rule is
  refused before the connector runs — `dto.invalid` naming `tenantId` and the rule, never the id.
- A retrieval outside an execution (a search tool called by hand, no frame) is
  `context.unavailable` — never the `default` tenant's documents. `testRag(R)` searches as its
  unit's tenant (`tenant: { tenantId }`, else `default`).
- `agboss rag index --tenant <id>` builds that tenant's knowledge bases (default `default`); a
  `--tenant` that is no key's text is exit 2, `usage.option-value`.

### Prove it — `ragConnectorContract`

A connector of your own runs the published contract suite in its own vitest, the cases the reference
connector runs:

<!-- snippet-context
import { ragConnectorContract } from "@agboss/core/testing/contracts";
import type { RagConnector, RagRetrieval } from "@agboss/core/rag";
declare class MyConnector implements RagConnector {
  retrieve(): Promise<RagRetrieval>;
}
declare function seed(connector: MyConnector, tenantId: string, documents: readonly { source: string; text: string }[]): Promise<void>;
declare function truncate(): Promise<void>;
-->

```ts
ragConnectorContract({
  name: "my-vector-store",
  connector: () => new MyConnector(), // a fresh one over an empty knowledge base, per case
  documents: (connector, tenantId, documents) => seed(connector, tenantId, documents), // the tenant's whole source
  reset: truncate, // after each case
});
```

`documents` puts `{ source, text }` documents where the connector's `index` reads them; the suite
calls `index({ tenantId, signal })` next when the connector has one. `RAG connector contract
(<name>)` checks: a passage only tenant B has never reaches tenant A (and B finds it); fifteen
near-identical tenant ids each get their own passage only; indexing the same documents twice leaves
one set of chunks, a changed document's old text and a removed document are gone, another tenant's
chunks stay; at least one and at most `topK` results; an aborted signal rejects `retrieve` and
`index`; `costUsd` absent or a finite number from 0; every result with a text and a source. A
connector that ignores the tenant, folds its id, appends on re-index, ignores `topK` or the signal,
or reports `NaN` fails its case (the core's own bite proofs).

## Reranking

Retrieval ranks the truly relevant passage below near-misses more often than not. A knowledge base
reranks (#703) by asking its connector for more `candidates`, re-ordering them with a more precise
model and giving the agent the best `keep` — `rerank` takes the place of `topK` (both, or neither,
do not compile):

```ts file=rerankers/docs.reranker.ts
import { Reranker } from "@agboss/core/rag";

// the core's LLM reranker on any chat model of the application's providers
@Reranker({ name: "docs-reranker", description: "Reranks the docs", model: "openai/gpt-4.1-nano" })
export class DocsReranker {}
```

<!-- snippet-context
import { Rag, RerankFailurePolicy, SqliteFtsConnector } from "@agboss/core/rag";
import { DOCS_INDEX } from "./rag/company-docs.rag.js";
import { DocsReranker } from "./rerankers/docs.reranker.js";
-->

```ts
@Rag({
  name: "reranked-docs-rag",
  description: "Nimbus Labs docs, reranked",
  rerank: { by: DocsReranker, candidates: 30, keep: 4, onFailure: RerankFailurePolicy.Fallback },
  deps: [DOCS_INDEX],
})
export class RerankedDocs extends SqliteFtsConnector {}
```

| Setting     | What it is                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `by`        | a `@Reranker` class (`rerankers/*.reranker.ts`, name ending `-reranker`)                        |
| `candidates`| how many results the connector is asked for                                                     |
| `keep`      | how many reach the agent, best first (`1 ≤ keep ≤ candidates`, else `[rag.rerank-invalid]`)     |
| `onFailure` | `RerankFailurePolicy.Fallback` (default) or `RerankFailurePolicy.FailStep`                       |

It works with any connector and in both modes: the search tool returns the reranked `keep`, the
context block holds them; `testRag(R)` reranks the same way (`model: replyWith(…)` scripts a model
reranker), and a scripted agent searches a knowledge base with `callTool(CompanyDocs, { query })`.

**The LLM reranker** (`DecidedBy.Model`, the default) is an empty class: `model` is any chat model of
the application's providers, a cheap one by default (`DEFAULT_RERANKER_MODEL`, `openai/gpt-4.1-nano`;
under providers that do not serve it `[model.unserved]` names `rerankers.<name>`; a decision model is
`[reranker.decision-model]`). One call per reranking: the query and the numbered candidates in, a
JSON ranking out (`{"ranking":[27,1,2]}`) — the model names candidates by number, never rewrites
one; the ones it does not rank follow in retrieval order. Its retries, rate limit and breaker are its
provider's. In tests: `mockLlm(DocsReranker).thenReturn(replyWith('{"ranking":[27,1,2]}'))`;
unscripted it ranks nothing (the retrieval's order).

**Your own reranker** — a dedicated API such as Cohere Rerank, on its official SDK, no AGBoss
wrapper — is code:

<!-- snippet-context
import { DecidedBy } from "@agboss/core";
import { Reranker, type RagReranking, type RerankerHandler, type RerankOptions } from "@agboss/core/rag";
import type { RagSearchResultDto } from "@agboss/core/dto";
declare const rerankApi: { rerank(query: string, documents: readonly string[], topN: number): Promise<readonly { index: number; score: number }[]> };
-->

```ts
@Reranker({ name: "api-reranker", description: "A rerank API", decidedBy: DecidedBy.Code })
export class ApiReranker implements RerankerHandler {
  async rerank(query: string, candidates: readonly RagSearchResultDto[], options: RerankOptions): Promise<RagReranking> {
    const ranked = await rerankApi.rerank(query, candidates.map((c) => c.text), options.keep);
    const results = ranked.flatMap(({ index, score }) => {
      const candidate = candidates[index];
      return candidate === undefined ? [] : [{ ...candidate, score }];
    });
    return { results, costUsd: 0.002 };
  }
}
```

Swapping one reranker for another is the `by` of one `@Rag` — nothing else changes. The full
example with Cohere Rerank, offline: agboss-examples
[`13-rag-reranking`](https://github.com/agbossjs/agboss-examples/tree/main/13-rag-reranking).

**What a reranker may return:** a subset of the candidates it was given — the same `source` and
`text`, none twice, at most `keep`. Anything else is a failure, so no reranker can put a passage
the tenant's retrieval did not return before the agent ([Tenants](#tenants)); it sees only the
current tenant's candidates (`options.tenantId`). `ragConnectorContract({ …, rerank: { by,
candidates } })` runs the contract's cases through the reranking under
`RerankFailurePolicy.FailStep` (#799): a reranker that throws or returns a passage that is no
candidate fails the cases that retrieve, never falls back to the retrieval's own order.

**When it fails** (it throws, times out, gives no ranking, or an invalid result):

- `RerankFailurePolicy.Fallback` (default) — the retrieval's own first `keep`; the trace has the
  failed span `rerank:<name>` and a span `rerank:<name>:fallback` with the reason.
- `RerankFailurePolicy.FailStep` — `RerankFailedError` (`step.rerank-failed`, a `StepFailedError`:
  `rag`, `reranker`, `cause`) fails the agent's step in both modes — context mode does not swallow
  it, tool mode does not hand it to the model; `.onError(RerankFailedError, …)` may take it.

**PII (#708):** the core's LLM reranker reads the query and the candidates — their texts and
sources — as the reading agent's own model does: through that agent's PII policies (the application's,
the workflow's and the agent's own), with its execution's sensitive values and key. In context mode the
reading agent is the one the knowledge block is for, in tool mode the one that searches. A candidate
holding `alice@example.com` under a `replaceWithToken()` rule reaches the reranker's model as
`<email:7f3a91>`; the reranked passage reaches the agent as retrieved, its own boundary masking it as
before. A block rule in a candidate refuses as it would at the agent's own model — the search call
refused (the model reads `Tool error: the call was refused: …`), in context mode the execution
(`PiiRefusedError`) — and the reranker's model reads nothing. A code reranker's call
(`DecidedBy.Code`) is the project's own, unmasked, as a connector's embeddings call is.

**Cost and traces:** the reranking is the span `rerank:<rag name>` (its query masked as above), its model call inside it; its
spend is billed to `rag:<rag name>` (category `retrieval`) with the reranker's model — a code
reranker's `costUsd` under its `@Reranker` name — so it is in `result.spend`, the ledger and every
budget, counted at once. `npm run describe`: `rag: reranked-docs-rag (tool, k 4, reranked by
docs-reranker from 30, on failure fallback)`.

## Costs and traces

Retrieval is billed to `rag:<name>` — FinOps category **`retrieval`**; context retrieval is a named
span `rag:<name>` in Langfuse, tool mode is traced as a tool.

## Index

```bash
npx agboss rag index   # every knowledge base of the application [--rag company_docs] [--tenant acme]
# company_docs: 3 documents, 5 chunks, 0 unchanged · $0.000000
```

## The reference implementation — `SqliteFtsConnector`

SQLite FTS5 (built into Node's `node:sqlite`), ranked by BM25 — no dependencies, no cost. `index()`
splits Markdown at headings and paragraphs (≤ 800 characters) and skips files whose content hash did
not change; each document's chunks are replaced in one transaction (a second process or a crash
never leaves two sets); the index is built on first use when the tenant's is empty. Every chunk is
its tenant's (#700): `folder` is one folder every tenant indexes for itself, or a function giving
each tenant its own — look it up, never build the path from the id (a tenant id may hold `/` or
`..`):

<!-- snippet-context
import { provide } from "@agboss/core";
import { DOCS_INDEX } from "./rag/company-docs.rag.js";
const folders = new Map([["acme", "docs/acme"], ["globex", "docs/globex"]]);
-->

```ts
provide(DOCS_INDEX, { folder: (tenantId: string) => folders.get(tenantId), dbFile: "docs.sqlite" });
```

An index file written before #700 migrates itself on first open: its chunks become the `default`
tenant's (`PRAGMA user_version` 1), another tenant indexes its own copy on its first retrieval; a
file of a later version is refused (`rag.index-version`), never rewritten. It finds words, not meanings (no
synonyms): for semantic search write another connector (e.g. `sqlite-vec` + an embeddings model).

`npm run describe` shows each agent's bases: `rag: company_docs (tool, k 4)`.
