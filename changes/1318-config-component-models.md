---
section: Breaking
issue: 1318
---

**The `ragRerankers`, `fileTranscribers` and `fileMaskers` shelves of a profile** (#1318, part 1318c).

- `ragRerankers: { "<reranker name>": { model, modelProvider } }`: the model (and the `@ModelProvider`, a class in a
  `.config.ts` or its name) a model `@RagReranker` is resolved to.
- `fileTranscribers: { "<agent name>": { model } }` and `fileMaskers: { "<agent name>": { model } }`: the model the
  built-in file transcriber / image redactor of that agent uses. The agent's config carries it, so the provider checks
  at start, the model registry and `describe` all read it. A file model is bound by its name (the gateway finds the
  provider that serves it): these two shelves take no `modelProvider`.
- A name nothing has — or an agent that does not read that view — is a `ProfileError`; the declared components are
  never changed.
