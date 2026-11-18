---
section: Fixed
issue: 1231
---

**A streamed call of an agent with tools is recorded at its real cost too** (#1231): the first
fix lived in a subclass of LangChain's OpenAI client, and `bindTools` —
how an agent's tools are bound — makes a plain `ChatOpenAI` through `withConfig`, so an agent with a
tool, streamed on OpenRouter, still recorded each call at twice the wire's `usage.cost` (the run's
spend, the cost ledger, every budget) and its `servedBy` as `OpenAIOpenAI`; its finish reason was
lost too. The usage is now taken once where the client reads the wire — its fetch, which every copy
of the client keeps: a stream reaches LangChain with one usage report, the provider's last, in a
chunk of its own. `bindTools`, `withConfig`, `withStructuredOutput`, `withRetry` and `withFallbacks`
all record what the plain call records, and `withConfig` keeps the client's class.
