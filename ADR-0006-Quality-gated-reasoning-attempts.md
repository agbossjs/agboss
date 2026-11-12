# ADR-0006 — Quality-gated reasoning attempts

- **Status:** Superseded by [ADR-0015](ADR-0015-Own-agent-loop) — removed in #150; #123 brings the idea back as `BeforeAgentAnswerJudge` + `maxSendBacks`
- **Issue:** #79

## Context

The review pass asked Jev "another pass?" and returned the last pass. There was no quality goal,
no choice of what to return when passes ran out, and no way to require a minimum quality.

## Decision

- Agent setting `reasoning`: `threshold`, `maxAttempts`, `thinking` per attempt, `onExhausted`
  (`best` default | `last` | `fail`), optional `criteria` and judge `model`.
- A judge (Jev) scores each attempt (P(good)); at the threshold the attempt is returned at once.
  Below it, criteria give concrete feedback and the next attempt refines the previous answer with
  the next thinking level.
- Exhausted: best-scored, last, or `QualityNotReachedError` (the whole run fails, spend recorded).
- Only the returned attempt is in the route; all attempts with scores are in the result and the Turn.

## Consequences

- Easy tasks cost one attempt plus one cheap Jev call; hard ones get more reasoning only when needed.
- Independent best-of-N attempts are not implemented; they would be another strategy.
