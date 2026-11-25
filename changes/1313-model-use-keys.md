---
section: Breaking
issue: 1313
---

**Model use keys follow the component names** (#1313): the first segment of a model use's key (what a profile
override, `agboss check --models` and a startup error name) is `channelInterpreters` (was `replyInterpreters`),
`ragRerankers` (was `rerankers`), `fileTranscribers` (was `files.transcriber`) and `fileMaskers` (was
`files.redactor`); `MODEL_USE_KINDS` and `ModelUseKind` list them. Migration: use the new key where a use is named.
