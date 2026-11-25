---
section: Breaking
issue: 1289
---

**`ModelGuardrailInstance` leaves the root** (#1289, conformance) — the structural marker of a model guardrail's class is type machinery, not a contract.

- **Removed:** `ModelGuardrailInstance` from `@agboss/core`.
- **Added:** `FlowTypes.ModelGuardrailInstance`.
