---
section: Added
issue: 1011
---

**A transport provider may stream its text** (#1011): `ModelProviderHandler` gets an optional
`stream(request)` returning `{ textStream: AsyncIterable<string>, usage: Promise<ModelProviderUsage> }`
(`ModelProviderStream`, `@agboss/core/models`), the shape of the Vercel AI SDK's `streamText`. Each
chunk is a `textDelta` of `onStream`; a provider without `stream` keeps the one delta at the end.
The call goes through the same attempt runner as `complete()`: a failure before the first chunk is
retried by the `retryPolicy`; one after text fails the call, is never retried and counts once in the
circuit breaker (told at the end of the stream); a caller's abort is neither. Every wait — for a
chunk and for the `usage` after the last — is bound by the provider's `timeout`; a stall or a `usage`
that never settles is a `ModelProviderFailureError` (`ModelFailure.Timeout`) and the request's
`signal` is aborted so the SDK stops. Usage, cost and budgets are the plain call's. A call with tools
bound goes through `complete()` (a text stream carries no tool call), as does a run under `--chaos`.
