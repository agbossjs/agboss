---
section: Fixed
issue: 1301
---

**The eval judge sees the masked start input** (#1301): the task line an eval judge's model reads is the stored one, so a start DTO's `tokenize()` field is its token and its `mask()` field its mask, never the raw value.
