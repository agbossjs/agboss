---
section: Breaking
issue: 1291
---

**A yes/no decision question is `Decision.boolean(…)`, its answer a `probability`** (#1291):
`Decision.noul(instructions, criteria?)` is `Decision.boolean(instructions, criteria?)`,
`NoulQuestion` (`type: "noul"`) is `BooleanQuestion` (`type: "boolean"`) and `NoulAnswer`
(`{ type: "noul", noul }`) is `BooleanAnswer` (`{ type: "boolean", probability }`), the field named
like `GuardrailVerdict.probability`. `DecisionQuestion`, `DecisionAnswer` and `AnswerOf<Q>` follow.
`"noul"` is the Decisions API's own wire word and stays inside the HTTP client of the built-in
`DecisionsModelProvider`: a model provider's `routeTo` gets `BooleanQuestion`s and returns
`BooleanAnswer`s, the request on the wire and its fingerprint are unchanged. A test's
`decideWith({ id: 0.9 })` and a recorded decision request read `type: "boolean"`. The old names are
gone with no alias, and `@agboss/core/core` no longer re-exports either pair: in TypeScript it is a
compile error, so rewrite `Decision.noul(` as `Decision.boolean(` and `answer.noul` as
`answer.probability`.
