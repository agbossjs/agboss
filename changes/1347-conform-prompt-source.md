---
section: Breaking
issue: 1347
---

**`PromptValue` is gone: `prompt` is a `PromptSource`; an arbiter's `prompt` is read like any prompt** (#1347, conformance) — a bare text no longer compiles on `@Agent`, `@Router`, the guardrails, `@Memory` compaction, `@ChannelInterpreter` or `@ReplyInterpreter`; write `inline("…")` or a `./x.prompt.md` path. A JavaScript caller's bare text is `[prompt.bare-text]` at assembly.

- **Removed:** `PromptValue`; a route's `prompt` is still its own plain string.
- **Added:** the prompt problem `[prompt.bare-text]`; `ModelArbiterOptions.prompt` is a `PromptSource`, read at assembly with the workflow's variables, and part of the prompt version.
