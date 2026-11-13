---
section: Security
issue: 1006
---

**Text a blocking check rejects is never streamed** (#1006): an answer an output `@Guardrail` blocked
or a PII block rule refused (`blockWithRefusal`, a card number) was already on `onStream` and in the
A2A artifact when the run failed. An agent with such a check now holds its text until its checks
passed — judges, the PII block rule, the guardrails — and a refused answer never reaches the
stream, not one byte. This cannot be switched off. A task that ends FAILED, CANCELED or REJECTED
after streamed text no longer keeps it in the client's view: its stream ends with an empty last
artifact chunk before the final status.
