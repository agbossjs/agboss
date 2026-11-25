---
section: Added
issue: 1347
---

**`prompt` takes a file path, `inline(…)` or a list of them** (#1347): `prompt: "./scout.prompt.md"` (a string that starts with `./`, `../` or `/` is a file, read next to the declaring file at assembly with the file named in every problem), `prompt: inline("…")` or the tagged `` inline`…` `` (drops the indentation the lines have in common), and `prompt: ["../shared/tone.prompt.md", "./scout.prompt.md"]` read in order and joined with one blank line, on `@Agent`, `@Router`, `@InputGuardrail`, `@OutputGuardrail`, `@Compaction` and `@ReplyInterpreter`. New exports: `inline`, `InlinePrompt`, `PromptFilePath`, `PromptPart`, `PromptSource`. The rendered text, and so every prompt version, is the same as for `prompt: x` with `promptUrls`. Bare text, `promptUrls` and `file()` still work until #1347b.
