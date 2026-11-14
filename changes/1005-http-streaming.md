---
section: Fixed
issue: 1005
---

**HTTP providers stream the answer token by token** (#1005): with the default OpenRouter provider
(and any OpenAI-compatible one) `onStream` heard no `textDelta` at all — the call was never a
stream — so `agboss run "<task>"` printed no answer and an A2A stream gave statuses and the final
artifact only. In a run that has `onStream` the call now goes out as a server-sent stream with
`stream_options.include_usage` (usage, cost and budgets are exactly a plain call's), each token is a
`textDelta` (empty ones are left out), and a run without `onStream` is a plain call as before.

- **A failed stream is never a success.** An `{error}` inside the HTTP 200 or a cut before the first
  text is a failed attempt: retried under the provider's `retryPolicy`, a 429 pauses the provider
  as a 429 status does. After text it is not retried (the text is out): the call fails and counts
  once in the circuit breaker, which is told at the end of the stream, not at its headers. A stream
  that ends without `[DONE]` or a finish is a failure too; a caller's abort is neither.
- **Metadata survives the chunks**: the host that served the call (`servedBy`) when only early
  chunks name it, `usage.cost`, and `finish_reason` (a streamed answer cut at the token limit says so).
- **A fallback model streams** like the primary. A primary that dies mid-stream with its breaker
  open is answered by the fallback from the start, after a `discarded` event (`stream-broken`, #1006).
- **`agboss run`** without `--json` prints the answer from the result when nothing streamed.

A cut stream is a `ModelFailure.NetworkError`, which the default `TRANSIENT_FAILURES` does not list: add it to `retryOn` to retry a cut before the first text. A transport provider's `complete()` still streams the whole answer as one delta at the end.
