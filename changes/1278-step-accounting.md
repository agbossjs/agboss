---
section: Breaking
issue: 1278
---

**Actions and external tasks count toward `maxSteps`** (#1278b, D8). A visit of an `@Action` and of an
`@ExternalTask` is a step like an agent's and a router's; the default `maxSteps` is now
(agents + routers + actions + external tasks) × 3. A loop through actions is bounded by `maxSteps`, not
only by `maxVisits`. An action on a side path that took a limit (`.onError(LimitExceededError, toAction(…))`)
and an undo the side path owes are not steps: a limit's own reaction is never held back by the limit.
Assembly warns with `[limits.max-steps-above-0.1.0-default]` (an error under `--strict`) when a flow
without `maxSteps` has a worst case above 0.1.0's default; a fan-out of actions needs an explicit
`@Workflow({ maxSteps })` (`[limits.max-steps-too-low]`). `agboss describe` prints "steps" in the worst-case
report, not "agent and router steps".
