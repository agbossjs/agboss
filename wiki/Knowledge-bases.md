# Knowledge bases (RAG)

A knowledge base is a class that extends `RagSource` — embeddings or full-text, local or an API,
SQLite or a vector DB — annotated `@Rag`. The core wires it: agents that list it in `rag` get its
passages before their first model call, and anything else (a `@Tool`, an `@Action`) injects it and
calls `search(query)`. Both go through one pipeline — scope, reranking, PII policies, cost and
tokens into the budgets, tracing — so a caller cannot bypass any of it: `retrieve` is `protected`.
`@Rag` and `@Tool` are orthogonal: `@Tool` knows nothing of `@agboss/core/rag`. Decision:
[ADR-0010](ADR-0010-RAG-as-a-contract).

<!-- snippet-context
import type { RagIndexReport, RagRetrieval, RagRetrieveOptions, RagIndexOptions } from "@agboss/core/rag";
-->

```ts no-check: the contract in outline, declarations only
abstract class RagSource<TFilter = never> {
  protected abstract retrieve(query: string, options: RagRetrieveOptions<TFilter>): RagRetrieval | Promise<RagRetrieval>;
  protected index?(options: RagIndexOptions): RagIndexReport | Promise<RagIndexReport>; // optional: build / update one scope's index
  resolveScope?(context: TContext): string; // RagScope.Custom only
  search(query: string, options?: { topK?: number; filter?: TFilter }): Promise<RagSearchResultsDto>;
}
interface RagRetrieval {
  results: readonly RagSearchResultDto[]; // { text, source, score?, id?, title?, url?, metadata? } (@agboss/core/rag)
  costUsd?: Usd; // what the retrieval cost: embeddings, a search API
  tokens?: number; // what an embedding model read: counts toward @Budget({ maxTokens })
}
// `source` is what the answer cites as [source]
```

## A knowledge base

The reference source, extended — its options go to `super` in a constructor of no arguments:

```ts file=rag/company-docs.rag.ts
import { Rag, RagScope, SqliteFtsRagSource } from "@agboss/core/rag";

// `topK` (search results per retrieval) and `scope` are required; there are no defaults
@Rag({
  name: "company_docs",
  description: "Nimbus Labs docs: onboarding, product, team",
  scope: RagScope.Shared, // one corpus every tenant reads
  topK: 4,
})
export class CompanyDocs extends SqliteFtsRagSource {
  constructor() {
    super({ directory: "docs", path: ".agboss/rag/company-docs.sqlite" });
  }
}
```

Or your own source — every call carries the scope's id, and `retrieve` returns that scope's
passages only ([Scopes](#scopes)):

```ts
import {
  Rag,
  RagScope,
  RagSource,
  type RagRetrieval,
  type RagRetrieveOptions,
} from "@agboss/core/rag";

@Rag({ name: "faq", description: "Answers to frequent questions", scope: RagScope.Tenant, topK: 3 })
export class Faq extends RagSource {
  private readonly entriesByTenant = new Map([
    ["default", [{ text: "Refunds take 5 days.", source: "faq.md#refunds" }]],
  ]);

  protected override retrieve(query: string, options: RagRetrieveOptions): RagRetrieval {
    const words = query.toLowerCase().split(/\s+/);
    const entries = this.entriesByTenant.get(options.scopeId ?? "") ?? [];
    const hits = entries.filter((entry) => words.some((word) => entry.text.toLowerCase().includes(word)));
    return { results: hits.slice(0, options.topK) };
  }
}
```

Dependencies come through the constructor (`@Rag({ deps: [...] })`), like any
[component](Components) — call `super()` first. The knowledge base is listed in the workflow's
`providers` when a tool injects it. Swap the implementation in this one file — nothing else changes.

## Using it — two ways, no mode

<!-- snippet-context
import { inline, Agent, Tool } from "@agboss/core";
import { RagQueryDto, RagSearchResultsDto } from "@agboss/core/rag";
import { CompanyDocs } from "./rag/company-docs.rag.js";
-->

```ts
// 1. The context: the core puts the top results in the agent's input message, before its first model call
@Agent({
  name: "onboarding-agent",
  description: "Answers questions about the company",
  prompt: inline("Answer from the company docs; cite them as [source]."),
  model: "moonshotai/kimi-k2.6",
  rag: [CompanyDocs], // a list of @Rag classes; one listed twice is [agent.duplicate-rag]
})
export class OnboardingAgent {}

// 2. A search tool: an ordinary @Tool over the knowledge base, with the ready-made DTOs
@Tool({
  name: "search-company-docs",
  description: "Searches the company docs",
  input: RagQueryDto, // { query }
  output: RagSearchResultsDto, // { results } — no cost or tokens in the output
  readOnly: true,
  deps: [CompanyDocs],
})
export class SearchCompanyDocsTool {
  constructor(private readonly docs: CompanyDocs) {}

  execute({ query }: RagQueryDto) {
    return this.docs.search(query); // topK and filter per call: search(query, { topK: 2 })
  }
}
```

| Way              | What happens                                                                                   | On error                       |
| ---------------- | ---------------------------------------------------------------------------------------------- | ------------------------------ |
| `rag: [Docs]`    | before the agent's loop the core retrieves `topK` results for its input message, appended as `Knowledge (<name>):` | the step fails (no silent turn without its knowledge) |
| a `@Tool` / `@Action` that calls `search(query)` | the agent decides when and what to search; `@BeforeTool` / `@AfterTool`, `timeout`, `maxResultSize` apply as to any tool | returned to the model (any tool) |

Both ask the model to cite `[source]`. A tool can compose several knowledge bases or filter by
metadata (`RagSource<TFilter>`, `search(query, { filter })`). Omitting `topK`, `scope` or `retrieve`
is a compile error. `search` runs inside a step or a tool call: outside one it is
`context.unavailable`.

## Scopes

A knowledge base is scoped, like every store of AGBoss. **Whose content it serves is declared**:
`@Rag({ scope })` is required, and a call that cannot name its scope reads nothing — it fails
closed, never another scope's passages.

| `scope`           | `options.tenantId` / `options.scopeId` of a call                                              | The source                                                                 |
| ----------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `RagScope.Shared` | none (both `undefined`)                                                     | serves one corpus every tenant may read (a public help center)             |
| `RagScope.Tenant` | the execution's tenant id, as both                                                | keeps each tenant's passages apart                                         |
| `RagScope.Owner`  | the execution's tenant and its owner (`CallOptions.owner`; none → `rag.scope-unresolved`) | keeps each owner's passages apart                                          |
| `RagScope.Custom` | what the tenant and what `resolveScope(context)` of the source returns (an org and a department, …) | keeps each scope apart; the source must have `resolveScope` (`[rag.custom-scope-missing-resolver]`) |

**Every scope but `Shared` is bound to the tenant**: an owner id or a custom key is unique within a tenant only, so a call carries both `tenantId` and `scopeId` and a source keys its rows on the pair — each part compared as given, never joined into one string (`("a", "b:c")` and `("a:b", "c")` are two scopes); only the declared global `Shared` spans tenants. The id is compared **as given** — `acme`, `Acme`, `ａｃｍｅ`, `café` and `cafe` are five scopes — and
is a key's text ([Several instances](Several-instances), #552): one that breaks a rule is refused
before the source runs — `validation.dto-invalid` naming the rule, never the id. A shared source is never told
a tenant. TypeScript cannot see whether a source reads the scope, so the choice is stated where a
reviewer reads it. Without `scope` the decorator does not compile; a JS project or a cast is
`[rag.scope-required]` at assembly. `agboss describe` prints it — `rag: faq (k 3, tenant)` — and
`describe --json` (each agent's `rag[].scope`) and the `configHash` carry it, so switching a
knowledge base to `Shared` is a reviewed change.

<!-- snippet-context
import { Rag, RagScope, RagSource, type RagRetrieval } from "@agboss/core/rag";
import type { ExecutionContext } from "@agboss/core";
-->

```ts
// a custom scope: one per organisation and department
@Rag({ name: "playbooks-rag", description: "Internal playbooks", scope: RagScope.Custom, topK: 4 })
export class PlaybooksRag extends RagSource {
  override resolveScope(context: ExecutionContext): string {
    return `${context.tenant.tenantId}:${context.ownerId ?? "nobody"}`;
  }

  protected override retrieve(): RagRetrieval {
    return { results: [] };
  }
}
```

- A retrieval outside an execution (a search called by hand, no frame) is `context.unavailable` —
  never the `default` tenant's documents. `testUnit(R)` searches as its unit's tenant
  (`tenant: { tenantId }`, else `default`; `ownerId` for `RagScope.Owner`).
- `agboss rag index --tenant <id> [--scope <id>]` builds that tenant's knowledge bases: `--tenant` is
  required when a target `@Rag` declares a scope other than `Shared` (`rag.tenant-required`), and an
  `Owner` or `Custom` one needs `--scope` too (`rag.scope-required`, the owner or custom key within
  the tenant) — a shared one is built with neither, so a multi-tenant application never names a
  tenant for it. An id that is no key's text is exit 2, `usage.option-value`; a refusal builds nothing.

### Prove it — `ragSourceContract`

A source of your own runs the published contract suite in its own vitest, the cases the reference
source runs:

<!-- snippet-context
import { ragSourceContract } from "@agboss/core/testing/contracts";
import { RagScope, RagSource, type RagRetrieval } from "@agboss/core/rag";
declare class MySource extends RagSource {
  protected retrieve(): RagRetrieval;
}
declare function seed(source: MySource, scopeId: string, documents: readonly { source: string; text: string }[]): Promise<void>;
declare function truncate(): Promise<void>;
-->

```ts
ragSourceContract({
  name: "my-vector-store",
  scope: RagScope.Tenant, // as its @Rag says; Shared runs the shared cases
  source: () => new MySource(), // a fresh one over an empty knowledge base, per case
  documents: (source, scopeId, documents) => seed(source, scopeId, documents), // the scope's whole source
  reset: truncate, // after each case
});
```

`documents` puts `{ source, text }` documents where the source's `index` reads them; the suite calls
its `index({ scopeId, signal })` next when it has one. `RAG source contract (<name>)` checks: a
passage only scope B has never reaches scope A (and B finds it); fifteen near-identical scope ids each
get their own passage only; indexing the same documents twice leaves one set of chunks, a changed
document's old text and a removed document are gone, another scope's chunks stay; at least one and at
most `topK` results; an aborted signal rejects `retrieve` and `index`; `costUsd` absent or a finite
number from 0; every result with a text and a source. A source that ignores the scope, folds its id,
appends on re-index, ignores `topK` or the signal, or reports `NaN` fails its case (the core's own
bite proofs).

A **shared** source (`scope: RagScope.Shared`) says so to the suite. In place of the isolation cases
it checks that every asker — the fifteen near-identical ids too — gets the same results for the
same query; that a re-index replaces the corpus for everyone who read it before; and that no call to
the source carries a scope id (through the core's reranking too). `documents` is the one corpus,
whatever its `scopeId`. The `topK`, signal, cost and shape cases run for all scopes; another `scope`
value is refused, never an empty suite.

## Reranking

Retrieval ranks the truly relevant passage below near-misses more often than not. A knowledge base
reranks by asking its source for more `candidates`, re-ordering them with a more precise model and
giving the agent the best `topK`: `@Rag({ topK, reranker })` names a `@RagReranker` class, and the
reranker carries the `candidates`. `1 ≤ topK ≤ candidates`, else `[rag.rerank-invalid]`.

```ts file=rerankers/docs.reranker.ts
import { RagReranker } from "@agboss/core/rag";

// an empty class is the core's LLM reranker, on the model of its provider's cascade
@RagReranker({ description: "Reranks the docs", candidates: 30, model: "fast" })
export class DocsReranker {}
```

<!-- snippet-context
import { Rag, RagScope, SqliteFtsRagSource } from "@agboss/core/rag";
import { DocsReranker } from "./rerankers/docs.reranker.js";
-->

```ts
@Rag({
  name: "reranked-docs-rag",
  description: "Nimbus Labs docs, reranked",
  scope: RagScope.Shared,
  topK: 4,
  reranker: DocsReranker,
})
export class RerankedDocs extends SqliteFtsRagSource {
  constructor() {
    super({ directory: "docs", path: ".agboss/rag/reranked-docs.sqlite" });
  }
}
```

| `@RagReranker` setting | What it is                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `candidates`           | how many results the source is asked for (required)                                                   |
| `maxCandidateLength`   | a model reranker reads the first this many characters of a candidate (default 1200)                   |
| `onFailure`            | `RerankFailurePolicy.FailStep` (default) or `RerankFailurePolicy.Fallback`                            |
| `model`, `modelProvider` | a model reranker's model (a role of its provider, or a vendor's name) and `@ModelProvider`          |
| `name`, `description`  | optional: the name is the class name in kebab-case                                                    |

It works with any source and both ways of using it: `search` returns the reranked `topK`, the
context block holds them; `testUnit(R)` reranks the same way (`model: replyWith(…)` scripts a model
reranker), and a scripted agent searches with `callTool(SearchCompanyDocsTool, { query })`.

**The LLM reranker** is a class with no code: its model is its own `model`, else the default of its
`modelProvider`, else its workflow's, else its application's (`models.default` or `model` of the
provider). There is no default model of the core's own: none anywhere is `[model.missing]` /
`[model.missing-provider]`; a decision model is refused as one. One call per reranking: the query
and the numbered candidates in, a JSON ranking out (`{"ranking":[27,1,2]}`) — the model names
candidates by number, never rewrites one; the ones it does not rank follow in retrieval order. A
candidate's `id`, `title`, `url` and `metadata` stay intact. Its retries, rate limit and breaker are
its provider's. In tests: `mockModel(DocsReranker).thenReturn(replyWith('{"ranking":[27,1,2]}'))`;
unscripted it ranks nothing (the retrieval's order).

**Your own reranker** — a dedicated API such as Cohere Rerank, on its official SDK, no AGBoss
wrapper — is a `@RagReranker` class with a `rerank` method, sync or async, no `implements`:

<!-- snippet-context
import {
  RagReranker,
  type RagSearchResultDto,
  type RerankOptions,
  type RerankResult,
} from "@agboss/core/rag";
import { usd } from "@agboss/core/units";
declare const rerankApi: { rerank(query: string, documents: readonly string[], topN: number): Promise<readonly { index: number; score: number }[]> };
-->

```ts
@RagReranker({ name: "api-reranker", description: "A rerank API", candidates: 30 })
export class ApiReranker {
  async rerank(query: string, candidates: readonly RagSearchResultDto[], options: RerankOptions): Promise<RerankResult> {
    const ranked = await rerankApi.rerank(query, candidates.map((c) => c.text), options.topK);
    const results = ranked.flatMap(({ index }) => {
      const candidate = candidates[index];
      return candidate === undefined ? [] : [candidate];
    });
    return { results, costUsd: usd(0.002) };
  }
}
```

`options` has `topK`, `scopeId` and `signal`. Swapping one reranker for another is the `reranker` of
one `@Rag` — nothing else changes.

**What a reranker may return:** a subset of the candidates it was given — the same `id` (else the
same `source` and `text`), none twice, at most `topK`. Anything else is a failure, so no reranker can
put a passage the scope's retrieval did not return before the agent; it sees only the current
scope's candidates (`options.scopeId`). `ragSourceContract({ …, rerank: { by, candidates } })` runs
the contract's cases through the reranking under `RerankFailurePolicy.FailStep`.

**When it fails** (it throws, times out, gives no ranking, or an invalid result):

- `RerankFailurePolicy.FailStep` (default) — `step.rerank-failed` fails the agent's step in both
  ways of using it — the context does not swallow it, a tool does not hand it to the model;
  `.onError(…)` may take it. A broken endpoint or credentials is never a silent degraded search.
- `RerankFailurePolicy.Fallback` — the retrieval's own first `topK`; the trace has the failed span
  `rerank:<name>` and a span `rerank:<name>:fallback` with the reason. A knowledge base that may
  degrade says so on its reranker.

**PII:** the core's LLM reranker reads the query and the candidates — their texts and sources — as
the reading agent's own model does: through that agent's PII policies (the application's, the
workflow's and the agent's own), with its execution's sensitive values and key. A candidate holding
`alice@example.com` under a `tokenize()` rule reaches the reranker's model as `<email:7f3a91>`; the
reranked passage reaches the agent as retrieved, its own boundary masking it as before. A block rule
in a candidate refuses as it would at the agent's own model — and the reranker's model reads
nothing. A code reranker's call is the project's own, unmasked, as a source's embeddings call is.

## Costs and traces

A search is billed to `rag:<name>` — FinOps category **`rag`** — with the retrieval's `costUsd` and
`tokens` (a custom embedding source counts toward `@Budget({ maxTokens })`); the reranker's model call
is billed to `reranker:<name>` (the same category) and a PII policy's masking to `pii:<policy>`, each
under its own caller, wherever the search is called from (a tool, an action, the context). A free
search reports nothing; a paid one outside a step fails closed. The reranking is the span
`rerank:<rag name>` (its query masked as above), its model call inside it; a context retrieval is
the span `rag:<name>`. The output of a search tool never holds cost or tokens.

## Index

```bash
npx agboss rag index --tenant acme   # every knowledge base of the application [--rag company_docs]
# company_docs: 3 documents, 5 chunks, 0 unchanged · $0.000000
```

## The reference implementation — `SqliteFtsRagSource`

SQLite FTS5 (built into Node's `node:sqlite` from Node 22.16 — 22.13 to 22.15 have no FTS5 module:
the source then refuses its first use, naming the Node it needs), ranked by BM25 — no dependencies,
no cost. `index` splits Markdown at headings and paragraphs (≤ 800 characters, `maxChunkLength`)
and skips files whose content hash did not change; it reads every document of the scope first and
then writes every change — changed documents, removed ones — in one transaction on a connection of
its own: an interrupted run (an abort, Ctrl+C on `agboss rag index`, an unreadable file, a crash)
leaves the scope's index as it found it, never part of the new one, and a second process never
leaves two sets. Ctrl+C stops even a long write at once (exit 1, `rag.interrupted`, the transaction
rolled back). A scope never indexed is indexed by its first retrieval on the instance, once and
whole; then every retrieval only reads. After the documents change, run `agboss rag index`: a running
instance does not re-read a folder on its own. The file handle closes with the application
(`onDestroy`). Every chunk is its scope's: `directory` is one folder every scope indexes for itself
(a `Shared` source has one copy), or a function of the scope's whole key `{ tenantId, scopeId, scope }`
giving each scope its own — look it up, never build the path from the id (an id may hold `/` or
`..`). An owner id is unique within a tenant only, so for any scope but `Shared` the folder must
depend on the tenant: a function that answers one folder for the same `scopeId` in two tenants is
refused (`rag.directory-not-tenant-keyed`) at index time and at the scope's first use:

<!-- snippet-context
import { Rag, RagScope, SqliteFtsRagSource } from "@agboss/core/rag";
const folders = new Map([["acme", "docs/acme"], ["globex", "docs/globex"]]);
-->

```ts
@Rag({ name: "tenant-docs", description: "Each tenant's own docs", scope: RagScope.Tenant, topK: 4 })
export class TenantDocs extends SqliteFtsRagSource {
  constructor() {
    super({ directory: ({ tenantId }) => folders.get(tenantId ?? ""), path: "docs.sqlite" });
  }
}
```

The index is derived data: a file of an older version is dropped and rebuilt from the documents,
never migrated; a file of a later version is refused, never rewritten. It finds words, not meanings
(no synonyms): for semantic search write another source (e.g. `sqlite-vec` + an embeddings model).

`npm run describe` shows each agent's bases: `rag: company_docs (k 4, shared)`.
