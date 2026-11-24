---
section: Breaking
issue: 1289
---

**One `check(content)` on a code guardrail, a thread-safe `blocked(refusal?)`, `FileSummary`** (#1289)

- **Changed:** a code guardrail has a single `check(content: GuardrailContent)` — `content.files` is `[]` when none, `content.text` carries the masked text with the text of text files appended (a transcription, a CSV), and `GuardrailContent` gains `component` (the agent or router) and `side`; `GuardrailVerdict.blocked(refusal?)` carries the refusal of its own call, else the decorator's `refusal`, else the class's `refusal(content)` — none of the three fails closed (`GuardFailedError`); `GuardrailRefusal.refusal(content)` gets the checked content; `refusal` is optional on a code guardrail's decorator; `[guardrail.missing-refusal]` is for model guardrails only; `GuardedFileShown` is `FileSummary` (`sizeBytes: Bytes`).
- **Removed:** `GuardrailHandler.checkContent`, the `check(text: string)` form, `CodeGuardrailComputedOptions`.
