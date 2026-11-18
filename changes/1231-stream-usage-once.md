---
section: Fixed
issue: 1231
---

**A streamed answer on OpenRouter is recorded at its real cost, not twice it** (#1231): OpenRouter
sends a stream's usage on its last chunk, beside the finish choice. The streamed answer is its chunks
merged, and the merge added that usage to the one LangChain reports again, so a streamed call's
`usage.cost` was counted twice (the run's spend, the cost ledger, every budget, `agboss run`'s
`cost:` line) and its `servedBy` read `DekaLLMDekaLLM`. A provider that repeats its usage on several
chunks was counted once per chunk. Now the usage of a streamed call is the provider's last report,
taken once — whichever chunk carries it — and its host is set, never joined: a streamed call records
what a plain call of the same usage records.
