---
section: Breaking
issue: 1311
---

**One usage type for a model answer** (#1311): `ModelProviderResponse.usage` is the canonical `TokenUsage` (`cacheReadTokens` and `cacheWriteTokens` are now required, as for a streamed call's `result.usage`); `ModelProviderUsage` is removed.
