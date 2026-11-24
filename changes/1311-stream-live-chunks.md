---
section: Fixed
issue: 1311
---

**A transport stream's chunks are live, its failover is in the stream, and a held answer goes out
masked** (#1311, part b): `TransportChatModel` streams (`_streamResponseChunks`), so a caller that
streams the model — a breaker's fallback among them — hears each chunk as the provider sends it, the
usage, cost and finish reason in the last chunk. A primary that fails and opens its breaker is
answered by its `fallback` inside the same stream: before any text transparently, after text with a
`StreamEventKind.Discarded` event (`StreamDiscardReason.StreamBroken`) first. An agent whose stream is
held back (an output guardrail, a PII block rule) releases its answer as the text its checks read —
masked by its PII policies — never as the model's own tokens: `AgentStream.release(finalText?)`.
