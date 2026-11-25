---
section: Breaking
issue: 1310
---

**`@ChannelInterpreter` model options, `pause.channel-interpreter-missing`, tenant PII context** (#1310, conformance).

- **Changed:** `ModelChannelInterpreterOptions.model` is optional and `modelProvider?: Class` joins it (the cascade `@ChannelInterpreter` → `@Workflow` → `@Application`); an empty `@ChannelInterpreter` class with a `prompt` is a model interpreter; the code of `PauseError.ChannelInterpreterMissing` and `ReplyInterpreterMissingError` is `pause.channel-interpreter-missing` (was `pause.no-reply-interpreter`); a reply interpreter's PII contexts are built for `pause.tenantId`, not the default tenant.
