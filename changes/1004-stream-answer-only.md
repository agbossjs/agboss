---
section: Fixed
issue: 1004
---

**`onStream` and the A2A artifact carry the answer only** (#1004): a judge's verdict, a chat-model
router's routing JSON, a compaction's summary and every other model the framework calls for itself
were streamed as `textDelta`s beside the answer (on A2A, appended to the task's output artifact and
left in a FAILED task's view). The stream is no longer a callback of the run, so a model does not
hear it by inheriting one: it is reached only through the agent's own answering model call
(`callModel`) and the agent's tool calls. Routers, judges (`invoke` and `decide`), guardrails,
arbiters, PII detection models, compaction, rerankers, reply interpreters and launch deciders are
silent — and so is any model call a later component makes. An agent with an `output` DTO streams no
text. Tracing (Langfuse) still sees every call. A listener that throws no longer risks the run. No
migration: a consumer that filtered internal text by content can drop the filter.
