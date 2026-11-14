---
section: Breaking
issue: 940
---

**`ChannelHandler.withdraw`, `ChannelOf.withdraw` and `ChannelWithdrawal` are removed** (#940, #337):
a channel learns that its pause closed through `onPauseClosed(event: ChannelPauseClosedEvent)` — at
least once, not once best-effort — and also of an answer given elsewhere, which `withdraw` never
told. The log code `channel.withdraw-failed` is replaced by `pause.notice-failed` and
`pause.notice-dead`. Migrate: `override withdraw(withdrawal)` → `override onPauseClosed(event)`;
`withdrawal.resolution` → `event.reason` (`PauseClosedReason`), and deduplicate by `event.deliveryId`.
