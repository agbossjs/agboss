---
section: Added
issue: 940
---

**A channel and an application's listeners are told, at least once, whenever a pause closes**
(#940, #910): `ChannelOf.onPauseClosed(event)` — answered (by whom, the masked answer), expired,
cancelled, withdrawn, its tree ended — and `onPauseAnswerNotTaken(event)` replace `withdraw`; a
`@PauseListener({ name: "…-pause-listener" })` class listed in `@Application({ providers })` hears
every pause of the application open (`onPauseOpened`) and close (`onPauseClosed`). The notices are
written with the pause's change, in its transaction, and delivered after a crash by any instance,
in order per pause and receiver, in the pause's execution frame under a timeout; a hook that fails
is retried after 1 s, 2 s, 4 s … (at most 5 min), logged (`pause.notice-failed`) and set aside after
`retention.pauseRecords` (`pause.notice-dead`, an error). Every event carries `deliveryId`, the same
on every redelivery — deduplicate by it. A listener gets `pauseKey`, never the answering id of a
channel pause unless it is declared `allowAnswering: true`. New: log codes `pause.notice-failed`,
`pause.notice-dead`, `pause.notice-recipient-unknown`, `pause-timers.failed`; the health
component `pause-timers` beside `recovery-loop`; assembly rules `[pause-listener.duplicate-name]`
and `[pause-listener.not-a-handler]`; `agboss describe` lists the listeners.
