---
section: Breaking
issue: 1311
---

**A streamed call settles with `result`, and the stream's events are enums** (#1311, part a): a
transport provider's `stream(request)` returns `{ textStream, result }` — `result:
Promise<ModelProviderStreamResult>`, `{ usage: TokenUsage, cost?, finishReason? }`, the shape
`complete()`'s answer holds beside its text — in place of `usage: Promise<ModelProviderStreamUsage>`,
whose `cost` and `finishReason` sat inside the usage; `ModelProviderStreamUsage` is gone and
`TokenUsage` is exported from `@agboss/core/models`. Usage, cost and budgets are recorded as before;
`result` must still settle when the stream ends, fails or is aborted, and one that settles to any
other shape (the old flat usage too) fails the call as the project's bug, never as a call of zero
tokens. On `onStream`, `ExecutionStreamEvent.kind` is a `StreamEventKind` (`TextDelta =
"text-delta"`, `Discarded = "discarded"`, `ToolCall = "tool-call"`) and a retraction's `reason` a
`StreamDiscardReason` (`JudgeRejected`, `ToolTurn`, `InvalidAnswer`, `StreamBroken`, `Failed`, the
values as before); the type `DiscardReason` is gone. A tool-call event carries `step` too — the step
of the model call that asked for it — so a parallel branch's tool call lands on its own branch. The
old forms have no alias: in TypeScript each is a compile error; rewrite `usage:
Promise.resolve({ inputTokens, outputTokens, cost })` as `result: Promise.resolve({ usage: {
inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, cost })`, `event.kind ===
"textDelta"` as `event.kind === StreamEventKind.TextDelta`, and `"toolCall"` / `"discarded"` the
same way. A consumer comparing the raw string sees `"text-delta"` and `"tool-call"` now.
