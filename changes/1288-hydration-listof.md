---
section: Breaking
issue: 1288
---

**A validated DTO is an instance of its class; `listOf(A, B, …)` is variadic** (#1288): every value a DTO schema validates — an agent's answer, a tool's arguments, an action's output — and every value read back from the scope after a resume or given to `testUnit` carries the class's prototype, so `item instanceof ScoreDto` and `item.constructor` hold (the prototype is set; nothing is frozen and no constructor runs). `listOf(ScoreDto, RejectedDto, FailedDto)` is one flat call for a homogeneous or a polymorphic list; an action returns plain object literals for a `oneOf` / polymorphic `listOf` output and the runtime tells each class by its strict schema, so assembly refuses classes one plain value could both be with `[dto.ambiguous-one-of]`. PII masking, file scrubbing, `stableJson` and the pause question comparison treat a hydrated DTO like the plain object it is (a `Date`, an `Error` or a typed array passes through untouched). `listOf`, `oneOf`, `optional`, `historyOf` and their wrapper types are no longer re-exported from `@agboss/core/dto`: import them from `@agboss/core`.
