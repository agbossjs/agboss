---
section: Breaking
issue: 1313
---

**Public model contracts no longer carry LangChain types** (#1313f). `ModelStartEvent.rawPayload`
(`BaseMessage[]`) is now `messages: readonly ShownModelMessage[]` (plain `{ role, content, toolCalls?,
toolCallId? }`, a file part by its meta, never its bytes) and `ModelEndEvent.rawContent` is
`content: string`. `JudgeModel.invoke` and `ArbiterModel.invoke` take `string | readonly
ModelMessage[]` (`{ role, content: string | ModelInputPart[] }`) in place of `BaseMessageLike[]`.
`mockLlm(...).requests`: `ChatLine.text` and a chat or decision request's `input` are `ShownContent`,
`tools` are `ChatToolDefinition[]`. `PartMeta.sizeBytes` is `Bytes`.

Added: `ModelMessage`, `ModelMessageRole`, `ShownModelMessage`, `ShownContent`, `ShownBlock`,
`ShownTextBlock`, `ShownToolCall`, `ChatToolDefinition`. Removed: `ModelStartEvent.rawPayload`,
`ModelEndEvent.rawContent`.
