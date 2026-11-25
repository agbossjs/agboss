---
section: Breaking
issue: 1289
---

**One `check(content)` on a code guardrail, a thread-safe `blocked(refusal?)`, `FileSummary`** (#1289)

- **Changed:** a code guardrail has a single `check(content: GuardrailContent)` — `content.files` is `[]` when none, `content.text` carries the masked text with the text of text files appended (a transcription, a CSV), and `GuardrailContent` gains `component` (the agent or router) and `side`; `GuardrailVerdict.blocked(refusal?)` carries the refusal of its own call, else the decorator's `refusal`, else the class's `refusal(content)` — none of the three fails closed (`GuardFailedError`); `GuardrailRefusal.refusal(content)` gets the checked content; `refusal` is optional on a code guardrail's decorator; `[guardrail.missing-refusal]` is for model guardrails only; `GuardedFileShown` is `FileSummary` (`sizeBytes: Bytes`).
- **Removed:** `GuardrailHandler.checkContent`, the `check(text: string)` form, `CodeGuardrailComputedOptions`.

**`DecidedBy` is off guardrails, a model and its provider on model guardrails, the component as a record** (#1289, the rest)

- **Removed:** `decidedBy` on `@InputGuardrail` / `@OutputGuardrail` — a guardrail that sets no `prompt`, `promptUrls`, `threshold`, `model` or `modelProvider` is decided by its class's `check(content)`; one that asks a question is a model guardrail (its class has no `check`, a compile error otherwise); `[guardrail.no-model]` (it is `[model.missing-provider]`, or `[model.missing]` when the provider has no default model); `GuardrailInput.element` and the string `GuardrailContent.component`; `agboss describe` prints a code guardrail as `code`.
- **Added:** `modelProvider?: Class` on model guardrails (with `model?`, resolved through `Guardrail → Workflow → Application`, #1313); `@InputGuardrail()` / `@OutputGuardrail()` with no options; `GuardrailInput.component` and `GuardrailContent.component` are a `ComponentRecord`; `name` and `description` stay optional.
