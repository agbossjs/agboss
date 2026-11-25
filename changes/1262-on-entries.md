---
section: Breaking
issue: 1262
---

**A root path of a flow begins with `on<Kind>(…)`** (#1262, #1273): `start(S)` is `onStart(S)`, and
the five bare nouns that continue a shared node in its own path are `onAgent(…)`, `onAction(…)`,
`onRouter(…)`, `onExternalTask(…)` and `onWorkflow(…)` (`question(…)` became `onExternalTask(…)`).
Every forward step keeps `to<Kind>(…)`, so `on…` now names a root path header or a condition
(`.onError`, `.onRoute`, `.onFinish`, `.onGroup`) and nothing else. The question role's step is
`.toExternalTask(Q)` and its side-path starter is `toExternalTask(Q)` (was `toQuestion`; the
decorator `@Question` is renamed separately in #1307). The old names are gone with no alias, so a
0.1.0 flow does not compile; `agboss describe`, the rule messages and `[flow.shared-node-inline]` /
`[flow.single-entry-own-path]` print the new names. The root export has both `onStart` (the flow
entry) and the lifecycle hook `OnStart` until #1324 renames the latter.
