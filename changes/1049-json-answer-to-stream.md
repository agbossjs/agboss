---
section: Fixed
issue: 1049
---

**An `onStream` listener no longer fails a run on a server that ignores `stream: true`** (#1049): an
OpenAI-compatible server or proxy that answers a streamed request with a plain `application/json`
completion made the run fail (`Received empty response from chat model call`, through a fallback
`config.model-provider`), while the same run without `onStream` answered. Such an answer is now the
call's completion — one `textDelta`, the plain call's output, usage, cost and `finish_reason`. A
streamed answer that is neither a stream nor a completion (an empty body, another content type, an
`{error}` inside the 200) is a failure of that one call, retried and counted by the breaker as any
other, never `config.model-provider`. No migration.
