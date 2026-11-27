---
section: Breaking
issue: 1307
---

**Every time a pause shows is a `Date`** (#1307, G3): `result.pending[]` and `ListedPause` (`askedAt`,
`expiresAt`, `closedAt`, the chain of custody's `at` and `expiresAt`), every channel and listener event
(`closedAt`, `at`, `expiresAt`, `previousExpiresAt`), `result.record.pauses` (`askedAt`, `resolvedAt`, `trail`),
`StepError.PauseExpired.expiresAt`, `LimitError.Deadline.deadlineAt` and `PauseError.Closed.closedAt?` were ISO 8601 texts and are `Date`s now;
a text for a log or a message is `date.toISOString()`. An error's `details`, the A2A wire (`a2a.pause-closed`)
and a stored record keep ISO 8601 texts (an error's `details` converts a `Date` fact itself). The store contract
(`PauseRecord`, the notices, the answer log) is `Date` too: see `1307-pause-dates-stores`. The framework compares pause times by instant
(`infrastructure/instants.ts`), never with `===` on two `Date`s.
