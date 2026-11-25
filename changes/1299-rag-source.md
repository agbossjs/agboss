---
section: Breaking
issue: 1299
---

**`@Rag` and `@Tool` are orthogonal building blocks** (#1299): a knowledge base is a class that
extends `RagSource` (`protected retrieve`, optional `protected index`, `resolveScope?` for a custom
scope) and the one public way in is `search(query, { topK?, filter? })`, which runs the pipeline —
the scope, the reranker, PII policies, the cost and tokens into the budgets — and returns a clean
`RagSearchResultsDto`. `@Agent({ rag: [Docs] })` is a list of classes whose passages come with the
input; a `@Tool` or an `@Action` injects the knowledge base (`deps: [Docs]`) and calls `search`, with
the ready-made `RagQueryDto` / `RagSearchResultsDto` of `@agboss/core/rag`.

- Removed: `RagMode`, `AgentRag` and `{ use, mode }`; the synthesized `search-<name>-tool`;
  `RagConnector`; `RagTenancy` (now `RagScope`: `Shared`, `Tenant`, `Owner`, `Custom`, required on
  every `@Rag`; `[rag.tenancy-required]` is `[rag.scope-required]`); `tenantId` alone on retrieve, index
  and rerank options (now the pair `tenantId` + `scopeId`, both none for `Shared`: an owner id or a
  custom key is unique within a tenant only, so a source keys its rows on the pair); `@Rag({ rerank })`, `@Rag({ prompt, promptUrls })`;
  `@Reranker`, `ModelReranker`, `RerankerClass`, `RerankerHandler`'s `implements`, `DecidedBy` on
  rerankers, `DEFAULT_RERANKER_MODEL`, `[reranker.missing-handler]`, `[reranker.decision-model]`;
  `SqliteFtsConnector` (now `SqliteFtsRagSource({ directory, path, maxChunkLength? })`);
  `ragConnectorContract` (now `ragSourceContract`); `RagFts5UnavailableError`,
  `RagIndexVersionError` and `RerankFailedError` are no longer exported; `RagSearchResultDto` and
  `RagSourceReferenceDto` moved from `@agboss/core/dto` to `@agboss/core/rag`.
- Added: `RagSource`, `RagScope`, `@RagReranker({ candidates, maxCandidateLength?, onFailure?,
model?, modelProvider? })` (an empty class is the LLM reranker, a class with `rerank()` is code),
  `RagQueryDto`, `RagSearchResultsDto`, `RagSearchOptions`, `[agent.duplicate-rag]`,
  `[rag.custom-scope-missing-resolver]`, `tokens` on `RagRetrieval` and `RagIndexReport`,
  `id` / `title` / `url` / `metadata` on `RagSearchResultDto`, `testRag`'s `ownerId` and `filter`.
- `RagScope.Owner` takes its id from the call's owner; a scope that cannot be named (no owner, a
  `resolveScope` that returns nothing, an unknown value) fails closed — the source is never called.
- A failing reranker fails the step (`RerankFailurePolicy.FailStep` is the default), and a failing
  retrieval of `rag: [...]` fails the step: neither degrades silently any more.
- A reranker's spend is billed to `reranker:<name>` and a PII policy's masking to `pii:<policy>`
  (both the `rag` category) wherever the search is called from; a zero retrieval reports nothing.
- `agboss rag index --tenant <id> [--scope <id>]`: `--tenant` is required for a knowledge base whose
  scope is not `Shared`, `--scope` too for an owner or custom one. The FTS index file is rebuilt, never migrated (`FTS_SCHEMA_VERSION` 2).
- A reranker's results are the retrieval's own passages, found by key: the reranker contributes
  their order and score only, never a text or a field. `SqliteFtsOptions.directory` is
  `(key: SqliteFtsDirectoryKey) => string | undefined` with `{ tenantId, scopeId, scope }` and is
  refused (`rag.directory-not-tenant-keyed`) when it answers one folder for a scope id in two
  tenants; `RagRetrieveOptions` and `RagIndexOptions` carry the declared `scope`.
