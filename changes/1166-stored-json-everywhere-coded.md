---
section: Fixed
issue: 1166
---

**Every other stored text that is not JSON fails with `StoredNamesUnreadableError` too** (#1166, after
#1121): an outbound call's stored result, a mesh request's response, an a2a task's status and a
message's reply, an audit event, an outbound call record, an execution tree value, a fenced effect's
result, a pause notice mailbox, a direct message's reply, an a2a file's metadata (disk and object
store) and a queued child's run or failure were parsed with a plain `JSON.parse`: a corrupt row threw
a `SyntaxError` with no `code` whose message quotes the stored text (PII in logs and spans, #906
D4-b). They are the coded error now (`code: "stored.unreadable"`, the record's name and ids), its
`cause` a `SyntaxError` that keeps no stored text.
