---
section: Breaking
issue: 1325
---

**Error families and `Result<T, E>`** (#1325, part a) — fifteen families of errors as one `type`, one
namespace of variants and one constructor each: `StepError`, `LimitError`, `GuardrailError`,
`PiiError`, `PauseError`, `IdempotencyError`, `OutboundCallError`, `FileError`, `ExecutionError`,
`ConfigError`, `ValidationError`, `DecisionError` in `@agboss/core`, `StoreError` in
`@agboss/core/stores`, `A2AError` in `/a2a`, `McpError` in `/mcp`. `err instanceof LimitError` narrows to
the union, `switch (err.kind)` (`LimitErrorKind.Budget`, …) is exhaustive, `err instanceof
LimitError.Budget` and `.onError(LimitError.Budget, …)` take one variant; every variant is named
`Family.Variant`, so two families never collide on a name. A project's error class without its own
`static code` is caught by its class name, never by every `AGBossError` through an inherited `agboss`.
`StoreError.of(kind, options)` builds a genuine `StoreError` for the store packages. A hand-over
(`ExecutionLeaseLostError`, `ApplicationStoppingError`, `ExecutionError.Fenced`) reaches no `.onError`,
not even `.onError(ExecutionError)`. `RecordedError` is an `AGBossError`.

`Result<T, E = AGBossError>` is a utility: `Result.ok`, `Result.err`, `Result.try(fn)` (keeps only an
`AGBossError` as an `Err`; a `TypeError` is thrown again) and `Result.tryAll(fn)` (keeps anything), with
`.unwrap()`, `.unwrapOr()`, `.map()`, `.mapErr()`. No `App` method returns one.

- **Removed:** `DecisionRequestError` and `DecisionResponseError` — they are `DecisionError.InvalidRequest`
  and `DecisionError.InvalidResponse`; the old class `DecisionError` is the family.
- **Added:** the families above with their `…Kind` enums, `Result`, `ResultFactory`, `TryOutcome`,
  `ErrorVariant`, `PaidErrorVariant`, `FamilyConstructor`, `VariantOptions` and their helpers.
- **Not yet moved:** the old error classes (`BudgetExceededError`, `StepFailedError`, …) are still thrown;
  each family's owning ticket moves its throw sites and removes the old class.
