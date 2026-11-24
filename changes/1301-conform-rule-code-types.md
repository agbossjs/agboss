---
section: Breaking
issue: 1301
---

**Rule-code sub-unions leave the root** (#1301, #1307, conformance) — `RuleCode` is the one public type; its decomposition is internal.

- **Removed:** `PiiRuleCode`, `PauseTargetRuleCode`, `ExtraRuleCode` and `PauseTargetHooks` from `@agboss/core`.
- **Added:** `FlowTypes.PiiRuleCode`, `FlowTypes.PauseTargetRuleCode`, `FlowTypes.ExtraRuleCode`, `FlowTypes.PauseTargetHooks`.
