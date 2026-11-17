---
section: Fixed
issue: 899
---

**The redaction model's values, answer files and padding, after the spec review** (#899, post-#1224):
"the same provider" for `RedactionValues.SameProvider` is now decided fail-closed — the same provider, or the
same base URL with the same key field, never a display name; not when the two models are of different vendors
behind one aggregator (the default OpenRouter with the default `google/gemini-2.5-flash-lite` no longer
counts as the agent's own provider for an `anthropic/…` agent), and not when the redaction provider's circuit
breaker can fail over to another provider: an application that relied on the old reading now stops at start
with `[files.redactor-values-withheld]` — pick a `redactionModel` of the agent's vendor, or set
`RedactionValues.Always`. An agent that reads files only as `FileView.Redacted` and answers with files is
`[files.answer-file-unseen]` (its pick failed at run time), and `AnswerFiles.Any` on an agent whose files a
PII policy masks, without `FileView.Original`, is `[pii.original-file]` (the model could return the unmasked
input). The redaction model is told to name a kind by the kind's own name, so a blocked kind is not read as a
value; a redacted region's padding is at most 5 % of the image's height and at least a quarter of its height
sideways. `FileRedactor` documents that an implementation never caches by `sha256` alone.
