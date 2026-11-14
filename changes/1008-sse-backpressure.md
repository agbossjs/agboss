---
section: Fixed
issue: 1008
---

**A slow SSE reader no longer grows the server's memory; a throwing stream listener is logged**
(#1008): the A2A server's SSE writer now waits for `drain` when the socket did not take a write
(a reader that takes nothing for 60 s is cut), each subscriber's queue joins the text deltas of
one step into one chunk and is bounded (1 MiB of text, 1000 events) — a subscriber over the bound
is dropped with a clean close and `stream.subscriber-dropped` in the log, and may subscribe again;
the run never waits for a reader. An idle stream writes the comment `: keep-alive` every 15 s of
the application's clock, so proxies with idle timeouts do not cut it. A listener of `onStream` that
throws is reported once per execution through the `Logger` (`stream.listener-failed`, Warn, with the
`executionId` and `tenantId`, never the text) instead of LangChain's console line; the run and the
listeners after it go on, also in the A2A server's fan-out.
