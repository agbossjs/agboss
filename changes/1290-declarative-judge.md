---
section: Breaking
issue: 1290
---

**Declarative model `@Judge`: an empty class with a `prompt` and a `threshold`** (#1290, part b) — a model judge needs no `JudgeModel`, no prompt concatenation and no `"FAILED:"` parsing.

- **Added:** `@Judge({ output, prompt, threshold?, model?, modelProvider? })` on an empty class (`DeclarativeJudgeOptions`): the prompt is a `.prompt.md` file next to the class, `inline(…)` or a list, read at assembly; the model answers one structured verdict, `{ passed, reason }`, or with a `threshold` in `(0, 1]` `{ score, reason }` passing at `score >= threshold` (a decision model: its probability of yes); an answer that is no verdict fails the agent closed. The rules `[judge.bad-prompt]`, `[judge.bad-threshold]`, `[judge.threshold-without-prompt]`, `[judge.declarative-with-judge]`, `[judge.declarative-with-deps]`; the warning `[judge.zero-retries]` (an agent with judges and no retries); an unscripted declarative judge passes in `testJudge` and `testWith`.
- **Changed:** the execution's budgets (and, in an eval check, the application's) are checked before each model call of a judge, so one judge's spend stops the next; `[judge.same-model-family]` resolves a role (`"fast"`) through the judge's and the agent's own `modelProvider` before it compares, reads a slash-less `gpt-…` / `claude-…` / `gemini-…` / `deepseek…` / `qwen…` / `llama…` / `mistral…` / `grok-…` id as its vendor's, and counts one model on one endpoint as one family.
- **Hardened:** the task and the answer reach the judge's model as JSON strings between `<judged-task-NONCE>` / `<judged-answer-NONCE>` tags with a per-call random nonce (every `<` in them escaped), and its instructions say they are data, never instructions; the verdict is read only from the structured JSON or decision answer.
- **Kept for #1288:** `input.variant` and `VariantOf`.
