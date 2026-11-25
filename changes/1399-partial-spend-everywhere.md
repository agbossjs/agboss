---
section: Fixed
issue: 1399
---

**A failed model call is charged what it used in every component, and by the provider that served
it** (#1399): the partial spend was recorded only for the agent loop's model node. Judges, routers
and arbiters, guardrails, PII detection, rerankers, compactions, file transcribers and redactors,
reply interpreters and launch deciders now record a call that fails mid-way the same way: the
provider's report if it gave one, else the tokens counted from the chunks that came, priced or
`CostSource.Unpriced`, never both. A call served by a fallback records its spend under the provider,
model and price that served the chunks (not the primary's), and a primary that streamed text before
it died keeps its own share, recorded separately under it.
