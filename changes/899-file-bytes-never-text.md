---
section: Security
issue: 899
---

**File bytes never leave as text** (#899 §0): an `A2AFileDto`'s `inline` was rendered, base64, into
an agent's prompt without a PII runtime, into a tool result, a code router's message, `onToolEnd`,
`ToolCallRecord`, `result.record`, observer events, traces and the turn lines. Every renderer now
shows `{ mediaType, filename?, sizeBytes?, sha256?, source }` (`redactedFileOf`) — always on, with
or without policies; a turn keeps the descriptor but not its bytes (`inline`).
