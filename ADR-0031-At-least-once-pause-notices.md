# ADR-0031: At-least-once pause notices written with the pause's change

Status: accepted (#910, #940)

## Context

A channel learned that its pause closed through `withdraw` (#337): once, best-effort, from the
instance that closed it. An instance that died between the close and the call left the Slack buttons
live; the channel never learned of an answer given elsewhere; nothing outside the channel could follow
pauses (a back office, a ticket system).

## Decision

- A notice (`opened`, `closed`, `answerNotTaken`) is written **in the store transaction of the change**
  that causes it, into one ordered mailbox per pause and receiver — never in a second step.
- Any instance delivers it: it claims the mailbox, tells the receiver in the pause's frame under a
  timeout and **acknowledges only after the receiver returned**. A crash anywhere before the
  acknowledgement delivers again, under the same `deliveryId`: at least once, never zero times.
  Exactly once is the receiver's, by `deliveryId` — the framework does not pretend to it.
- A failure retries with growing pauses and is finally set aside, logged as an error; there is no
  redelivery API (a receiver that wants one keeps its own queue).
- Two receivers: the channel that asked (`onPauseClosed`, only if it overrides a hook) and
  application-wide `@PauseListener`s; a listener gets a correlation key, not the right to answer.

## Consequences

`withdraw` is removed. The pause store contract carries the mailboxes (`claimNoticesDue`,
`ackNotice`, …); every store set passes the fault scenarios 21, 21b and 21c. A store that writes a
notice outside the change's transaction, or acknowledges before delivery, fails them
(`notices-once-each-in-order`) — kept as permanent negative tests.
