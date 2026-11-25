---
section: Fixed
issue: 1301
---

**A fresh `agboss create` project passes `check --models` and starts against OpenRouter** (#1301):
the scaffolded workflow set `defaults.router: { model: "typesafe/jev-1.13" }`, which resolves as a
chat model on the application's OpenRouter provider and fails `model.unknown-model` (also in
`createApp`). The router names its own model and provider, so the default is dropped. Existing
projects: remove `router` from the workflow's `defaults` when no router relies on it.
