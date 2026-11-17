---
section: Fixed
issue: 1249
---

**A transport provider's `stream()` reports the call's cost and why it stopped** (#1249, after #1011): the
settled `usage` of a `ModelProviderStream` may now carry `cost` (the plain call's `cost`) and `finishReason`.
Before, a provider with `ModelCost.fromResponse()` that implemented `stream()` streamed every plain-text
answer to the caller and then failed the call with `ModelCostError` (no cost, no price), and a streamed answer
cut at the output limit could not say so. A streamed call without a cost under `fromResponse()` still fails
(as `complete()` without one does). An empty first chunk no longer ends the attempt's retry window: a failure
right after it, before any text, is retried. No migration: both fields are optional.
