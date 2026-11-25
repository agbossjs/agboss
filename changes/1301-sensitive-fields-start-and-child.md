---
section: Fixed
issue: 1301
---

**Sensitive fields of a start DTO and of a child execution are masked in every stored copy** (#1301): a start DTO's `tokenize()` fields are stored as their tokens and its `mask()` fields as their masks in the task line of the execution record (so in the thread's memory the next turn's model reads), in the `input` of the history record and in an eval case's past turns; a child execution's input and output are stored so in its record (`history.children`, `result.record.children`) and in the output of its end event. The execution itself still works on the real values. Without a PII runtime a token field is stored as its placeholder (fails closed). Replaying a stored start line (`agboss eval replay`) therefore starts from the masked values.
