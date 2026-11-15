---
section: Fixed
issue: 1122
---

**A held agent streams its answer on an HTTP provider** (#1122 acceptance): an agent with an output
guardrail or a PII policy with a block rule — also an application-wide one — went out as a plain
(non-streamed) call and so streamed nothing: `onStream` got zero `textDelta`s while the result held the
answer. Its model call is now a stream like any other agent's, its tokens go to the holding buffer and
the answer reaches `onStream` (and an A2A artifact) once its checks passed; a refused answer still never
reaches it. The deltas of a held agent, joined, are its reply.
