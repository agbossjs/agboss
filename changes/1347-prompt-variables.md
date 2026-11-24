---
section: Breaking
issue: 1347
---

**`promptVariables` cascades and takes `defineEnv` references; a secret is refused** (#1347): `promptVariables: Record<string, string | EnvRef<string>>` (new type `PromptVariables`) is set on `@Application`, `@Workflow` and every prompt-bearing component (`@Agent`, `@Router`, `@InputGuardrail`, `@OutputGuardrail`, a `@Memory` compaction, `@ReplyInterpreter`, `@ChannelInterpreter`); the nearest level wins. An `env(…)` reference is read once at assembly, from `createApp`'s `processEnv`; one that is unset or no text is `[prompt.invalid-variable]`. A `SecretRef` at any level is `[prompt.secret-in-instructions]`: assembly fails closed and nothing is rendered, so a secret never reaches a prompt or a model. A key a component sets that none of its prompt texts uses is `[prompt.unused-variable]` (assembly, so also `agboss check --prompts`): delete it. A model reply interpreter's rendered instructions are part of `promptVersion` and `configHash`; a workflow without one keeps its hash. Added: `PromptVariables`, `@Application({ promptVariables })`, `promptVariables` on the guardrails, `@Memory` compaction and the interpreters.
