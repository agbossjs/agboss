---
section: Breaking
issue: 1328
---

**`pastTurn({ start, input, finish, output })`, and an eval suite's `cascade` and `description` are optional** (#1328, part d): `pastTurn` takes one options bag in place of four positional arguments; `agboss generate eval-case` writes it that way. `@EvalSuite({ cascade })` defaults to `EvalCascade.StopAtFirstFailure` and `description` may be left out. Added: `PastTurnOptions`.
