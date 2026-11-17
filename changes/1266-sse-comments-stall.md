---
section: Fixed
issue: 1266
---

**A streamed model answer that sends only comments after its first content is timed out** (#1125's bound, #1266): the provider's `timeout` between two chunks was restarted by every read of the body, so a provider that sent content once and then only `:` comment lines (a proxy's keep-alive, a hung provider) never stalled out — a hang. Only a data line (or another non-comment field) restarts the bound now; comments and blank lines do not, and the call fails as `ModelFailure.Timeout` at the bound, as for silence.

**`RagFts5UnavailableError` and `RagIndexVersionError` are exported from `@agboss/core/rag`**: the SQLite FTS connector throws them (a Node without FTS5; an index file of a later version), and a caller could not `catch` them by class.
