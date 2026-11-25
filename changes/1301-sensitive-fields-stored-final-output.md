---
section: Fixed
issue: 1301
---

**Sensitive fields of a final output are masked in every stored copy** (#1301, #1321d): the finish DTO's `tokenize()` fields are stored as their tokens and its `mask()` fields as their masks in the finish line of the execution record (so in the thread's history and in what a late resume of an ended tree reads back), in the `output` of the history record, in the output of the end event (and so of the A2A task written from it), in the reply a direct A2A skill keeps and sends, in the state read from a tree whose end is still being recorded, and in the past turns of an eval case. Without a PII runtime a token field is stored as its placeholder (fails closed). The caller of `execute` keeps the values it was given. `ServedOutput` has the output's `classes`.
