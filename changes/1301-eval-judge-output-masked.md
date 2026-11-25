---
section: Security
issue: 1301
---

**The eval judge's model reads the stored output, through the application's PII policies** (#1301,
#1328): the task line was already masked, but the judged answer reached the judge's model raw — a
`sensitive` field of the finish DTO and an email the policies hide from models went to the judge's
vendor as they were. The output is now the stored one (`tokenize()` as its token, `mask()` as its
mask, the observability policies applied, the DTO's class kept for a code judge) and the judge's
model reads through the same model-reading mask the agents' own judges use, so one value has one
token in the task and in the answer. No migration.
