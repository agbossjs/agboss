---
section: Breaking
issue: 1328
---

**Every test application names its `modelProvider`** (#1313, #1328, flip F2). `/testing` makes no provider of its own: an application, or a workflow assembled alone, that names none is `[model.missing-provider]`. `TestModelProvider` (`@agboss/core/testing`) is the provider a test names: `@Application({ modelProvider: TestModelProvider })` serves the chat agents, and the test's script answers every call before it is reached. The built-in transcriber and redactor models of an agent are served by the agent's provider.
