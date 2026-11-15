---
section: Security
issue: 1130
---

**A run's trace is masked by its own workflow's PII policies** (#1130): Langfuse's LangChain
handler exports through one process-wide provider, and every workflow replaced it with its own, so
the spans of every run were masked by the policies of the workflow the application built last — a
workflow without a policy let another workflow's raw values (span input, output and metadata) reach
Langfuse. Every workflow's tracing is now a route of one span processor: a span is masked by the
policies of the workflow its step belongs to, a span of no known workflow by every workflow's,
every string attribute included (Langfuse's flattened `metadata.*` attributes were not masked at
all). The provider is released only when the last application in the process closes, so a closed
workflow no longer drops the others' spans to the global OpenTelemetry provider. The application's
own log and audit log are masked by the union of every workflow's policies, not the application's
alone. No migration.
