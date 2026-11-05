# ADR-0010 — RAG as a contract, implementations by the developer

- **Status:** Accepted
- **Issue:** #88

## Context

Agents could only read whole files (MCP) or call APIs. Every project embeds and stores documents
differently, so a built-in embeddings model or vector store would be the wrong default.

## Decision

- The core defines `RagConnector` (`retrieve`, optional `index`); a `@Rag` class implements it
  (`k` required); agents bind it with a required `mode` — `tool` or `context`.
- The core does the wiring, cost reporting (category `retrieval`) and tracing; context retrieval
  fails open.
- The reference implementation is SQLite FTS5 (BM25): no dependencies, no cost, deterministic in tests.
- **Amended by #700:** tenant isolation is part of the contract, not of one connector. The core
  passes the execution's tenant on every `retrieve` and `index`; every connector returns and
  indexes that tenant's passages only, proved by the published `ragConnectorContract`. The earlier
  "no multi-tenant access control" is withdrawn; per-document access within a tenant is still the
  connector's.
- **Amended by #703:** reranking is under the same contract — a `@Reranker` (the core's LLM reranker
  on the application's model providers, or the project's code on a vendor's official SDK) bound by
  `@Rag({ rerank })`; the core runs it, checks its result is a subset of the tenant's candidates,
  bills and traces it, and falls back or fails the step as declared. No reranker package in the
  core: dedicated rerank APIs stay examples (agboss-examples `13-rag-reranking`).
- **Amended by #796:** whose content a knowledge base serves is declared, `@Rag({ tenancy:
  RagTenancy.PerTenant | RagTenancy.Shared })`, required. The type system cannot tell a connector
  that ignores the tenant on purpose (a public corpus) from one that forgot it, so the choice is
  stated where it is reviewed — describe, `describe --json`, the `configHash` — and checked at
  assembly (`[rag.tenancy-required]`). An enum rather than a flag leaves room for a third mode (a
  shared corpus plus the tenant's own).

## Consequences

- Semantic search is another connector under the same contract; swapping touches one file.
- The reference finds words, not synonyms.
