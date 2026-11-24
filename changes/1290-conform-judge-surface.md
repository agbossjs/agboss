---
section: Breaking
issue: 1290
---

**Judges: one `JudgedOutput` with the trajectory, `ModelJudgeOptions`, a narrower public surface** (#1290, conformance) — a code judge reads the agent's tool calls and files, the declarative judge's options are named like the other model components', and the helper types leave the root.

- **Removed:** `JudgedInput` (its `toolCalls` and `files` are on `JudgedOutput` now); `DeclarativeJudgeOptions` (renamed); `DeclarativeJudgeClass`, `HybridJudgeModelOptions` and `JudgeMethod` from the root (they are `FlowTypes.*`, type machinery).
- **Added:** `ModelJudgeOptions`; `JudgedOutput<TOutput>` carries `{ output, task, attempt, toolCalls, files }`; `FlowTypes.DeclarativeJudgeClass`, `FlowTypes.HybridJudgeModelOptions`, `FlowTypes.JudgeMethod`.
