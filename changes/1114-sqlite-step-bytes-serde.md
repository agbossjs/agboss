---
section: Fixed
issue: 1114
---

**SQLite: a checkpoint saver whose serde keeps the metadata type `json` but changes the bytes
(encrypts, compresses, wraps them in an envelope) no longer answers `latestByStep` by id** (#1114,
the rest of #1101): SQL reads `metadata.step` from plain JSON only, so every such checkpoint sat at
step -2 and the greatest id won. A thread's namespace that holds any row whose step SQL reads as -2
(bytes that are not plain JSON, another type, or no step) is now read through the saver's serde, and
answers what the scan answers; the probe is one lookup in a small partial index, `checkpoints_unreadable_step`
(it replaces `checkpoints_foreign_metadata`; opening a file drops the old one). On 1 000 000 checkpoints
the index costs about 0.3 s to build, nothing measurable per write, and 0.3 microseconds per probe.
Namespaces whose checkpoints all have a step (LangGraph always writes one) keep the one-walk indexed read.
