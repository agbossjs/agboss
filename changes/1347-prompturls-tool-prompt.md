---
section: Breaking
issue: 1347
---

**`promptUrls` and `ToolOptions.prompt` are gone** (#1347b): a prompt is `prompt: "./x.prompt.md"`, `inline("…")` or a list of them (`prompt: [inline("…"), "./tone.prompt.md"]`, read in order and joined with one blank line, so the rendered text and every prompt version are as with the old `prompt` + `promptUrls`). `promptUrls` is removed from `@Agent`, `@Router`, `@InputGuardrail`, `@OutputGuardrail`, `@Compaction`, `@ChannelInterpreter` and `@Tool`; `@Tool({ prompt })` (never read at run time) and `ToolMeta.prompt` are removed. The loader names a missing file as `prompt of @Agent "…"`.
