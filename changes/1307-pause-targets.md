---
section: Breaking
issue: 1307
---

**`@ToolApproval`, `@ExternalTask`, `@Channel({ target, ttl })`, `@ChannelSelector`, `@ChannelInterpreter` and `@ChannelListener`** (#1307a, #1310c): the
new names of `@ChannelRole`'s two forms and of `@ReplyInterpreter` / `@PauseListener`, added beside them — `@Tool({ approval })` for `channel`,
`PauseRespondent.Owner` / `.Delegate` for `PauseAnswerer`, `timeout` / `calendar` on the target for `expiresIn` / `workingCalendar`, the flat
`@Application({ channels, channelSelectors, channelListeners })` shelves, `ChannelInterpretation.notUnderstood(reason)`, every `@ChannelListener` hook
optional, `onPauseTimeoutChanged` for `onPauseExtended`, and the generated `PauseTargets` with `PauseInputOf` / `PauseOutputOf`. The old names go
with the platform flip.
