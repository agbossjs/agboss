---
section: Breaking
issue: 1290
---

**`@Judge` reads `output`, code and hybrid judges, `JudgeInput<Self>`, sync verdicts** (#1290, part a) — a judge uses the framework-wide `output` vocabulary, is decided by its class's code unless it injects `JudgeModel`, and no longer repeats its output type.

- **Removed:** `reply` on `@Judge` and on `JudgeInput` (now `output`); `decidedBy` / `DecidedBy` on `@Judge`; `JudgeMeta`, `ModelJudgeMeta`, `CodeJudgeMeta`, `JudgedReply`, `JudgeReplyShape`, `JudgeReplyOf`, `JudgeInputOf` (the old meaning), `JudgeHandlerClass`; the rule codes `[judge.wrong-reply]` and `[eval.judge-wrong-reply]`; the requirement that a judge `implements JudgeHandler` and returns a `Promise`.
- **Added:** `JudgeOptions`, `CodeJudgeOptions`, `HybridJudgeModelOptions`, `JudgeOutputShape`, `JudgedOutput`, `JudgedInput`, `JudgeOutputOf`, `JudgeOutputValueOf`; `@Judge({ model?, modelProvider? })` only with `JudgeModel` in `deps` (a hybrid judge; `model` left out is its provider's default role); `JudgeInput<Self>` reads the judge's output from the new generated table `AGBossTypes.JudgeOutputs` (or takes the output type directly); `judge(input)` returns `JudgeVerdict | Promise<JudgeVerdict>`; `judges: [...]`, `judgedBy(...)` and `testJudge(...)` take any class; the rules `[judge.wrong-output]` and `[eval.judge-wrong-output]`.
- **Changed:** `WorkflowFinishTextDto extends PlainTextDto` (its schema and hash are unchanged), so one `PlainTextDto` judge serves a text agent and a text finish; a text agent may lead to a finish of `PlainTextDto` too; a judge that names a `model` but injects no `JudgeModel` is `[judge.model-on-code-judge]`; a field a subclass redeclares replaces the inherited one in `fieldsOf`.
- **Left for #1288:** `input.variant`, `VariantOf` and `isVariant` stay in the judge's input until the DTO prototype hydration lands.
