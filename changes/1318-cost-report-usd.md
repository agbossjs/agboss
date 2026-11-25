---
section: Breaking
issue: 1318
---

**Every amount is `Usd`, and a cost report carries tokens** (#1318): `UsageRecord.costUsd`, `CostLine.costUsd`,
`CostReport.totalUsd` / `byCaller` / `byCategory` / `byModel`, `Turn.costUsd`, `Summary.costUsd`, `RagRetrieval` /
`RagIndexReport` / `RerankResult.costUsd`, the `spentUsd` of the limit errors, the mesh and A2A reports and the eval
reports are branded `Usd` (build one with `usd(0.5)`). `ModelEndEvent.calculatedCost` is `costUsd`.
`CostReport` has `inputTokens`, `outputTokens`, `cacheWriteTokens` and `totalTokens` beside `cacheReadTokens`, and is
built with `CostReport.fromUsage(records)` (was `buildCostReport`), `CostReport.empty()` and `CostReport.sum(reports)`.
`CostCategory` renames `Guards` to `Guardrails`, `Compaction` to `Memory`, `Retrieval` to `Rag` and adds `Pii`,
`Arbiters` and `Pauses`; `costCategoryOf` maps every caller prefix (`memory:`, `rag:`, `reranker:`, `pii:`,
`file-masker:`, `file-transcriber:`, `arbiter:`, `channel-interpreter:`). `CostSource.Unpriced` marks a call of a
provider with no price (its `costUsd` is 0, its tokens real). `CompactionContext.budgetLeftUsd` and
`MemoryTurn.budgetLeftUsd` are `Usd | undefined` (`undefined`: no USD limit). Stored cost reports changed shape; no
migration (0.1.0 data is not read).
