---
section: Security
issue: 1004
---

**The PII detection model's answer no longer reaches the user's stream** (#1004): with
`detectWithModel`, the detector's JSON — the raw value it found, such as `{"found":[{"kind":
"person-name","text":"Dana Cohen"}]}` — was a `textDelta` of `onStream` and of the A2A task's
artifact, before and after the answer, exactly what the masking layer exists to keep out of view.
It is silent now like every internal model call. Its own call stays visible to tracing, as before.
