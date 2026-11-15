---
section: Fixed
issue: 1125
---

**A provider's `timeout` bounds a model call after its first token too** (#1125 acceptance): the timeout
ended when the response head came, so a streamed answer that stalled halfway (a hung provider, a
half-open connection) waited forever, holding its lease and rate-limit room. It is now a stall bound: a
streamed answer quiet for the `timeout` after its first content fails as `ModelFailure.Timeout` (the text
so far is retracted as `stream-broken`; no retry, as for a cut stream; one breaker failure; the room is
given back), and the clock restarts at every chunk, so a long answer that keeps coming is never cut. A
plain call's body is read inside the attempt under the same timeout: a body that stalls after the headers
times the attempt out and is retried as a timeout.
