---
section: Breaking
issue: 1318
---

**`@Action`'s `execute` is sync or async, and an action has an optional `timeout`** (#1318, part 1318e). A pure data mapping returns its value
(`execute(input): Out`), an action that declares no `input` has `execute()`; `implements ActionHandler<Self>` only checks the signature and
`ActionResult` is `T | Promise<T>`. A sync throw is an action failure like a rejection. `@Action({ timeout })` (`Milliseconds`) fails a step that runs past it
with `StepError.ActionTimeout`; an action has **no** timeout by default (a tool's is 30 s).

Not yet: `maxVisits` on `@Action`, lazy `() => Class` for `compensateWith` / `committedBy` (they edit `flow/analyse`, `flow/runtime` of another lane),
the `Timeout.None` enum value (`timeout` absent means none), and the removal of `implements ActionHandler` from the in-repo uses (F2).
