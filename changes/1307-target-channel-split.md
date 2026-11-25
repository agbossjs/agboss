---
section: Breaking
issue: 1307
---

**A pause waits under a target, a channel carries it** (#1307, #1310): `@ChannelRole`, `ChannelOf`, `PauseAnswerer`,
`@Tool({ channel })`, `PauseKind.Question`, `@PauseListener`, `@ReplyInterpreter` (`DecidedBy` on interpreters),
`ReplyInterpretation`, `ChannelQuestionOf` / `ChannelAnswerOf` / `ChannelInputOf`, the generated `ChannelRoles` table,
`onPauseExtended`, `QuestionStepOptions` and every `expiresIn` of a tool, a step and a role are removed, and so is
`@Application({ workingCalendar })` (a working `timeout` or `remindBefore` names the target's own `calendar`).

Added: `@ToolApproval` and `@ExternalTask` are the only pause targets (`@Tool({ approval })`, `.toExternalTask(Task)`),
each with a required `timeout`; a `@Channel` names its `target` and a `ttl` and needs no `extends`; one with several
channels asks its `@ChannelSelector`. `PauseRespondent` (`Owner` = `"owner"`, `Delegate` = `"delegate"`, in place of
`PauseAnswerer`), `PauseKind.ExternalTask` (`"external-task"`), `ChannelInterpretationKind`, `ExternalTaskClass`,
`AgentToolClass`. A pause record, a pending pause, a listed pause, a listener event, an answer-log entry and
`PauseExpiredError` carry `target`; `channel` is the adapter asked and is absent for an owner's pause nobody is asked
about (`PauseAnswerRecord.role` is gone). `[pause.remind-before-*]`, `[limits.timeout-invalid]` and
`[calendar.required-for-working-duration]` replace the `channel.*` expiry rules; `AutoApproveChannel` and
`AutoRejectChannel` serve a target with `.for(Target)`. `app.listPauses({ role })` is `{ target }`, and the store filter
`PauseFilter.channel` is `PauseFilter.target`.

Store follow-up (T4): the pause row (JSON) carries `target`; `channel` may be NULL; the SQLite pause table's `channel`
column (the listing filter and its index) is `target`; `findPageByTenantId` filters by `target`; stored kind `"question"` is now
`"external-task"` and the stored respondent values are `"owner"` / `"delegate"`; the answer-log entry has `target` and
`channel` instead of `role`; a notice's recipient is still `channel:<name>`.
