---
section: Breaking
issue: 1324
---

**`TerminalUserChannel` is removed** (#1324): an approval or a task the thread's owner answers needs no channel — a `@ToolApproval` or `@ExternalTask` with `respondent: PauseRespondent.Owner` pauses the run, `agboss chat` / `agboss run` ask the owner for each pending pause, and code answers with `app.resume({ pauseId, decision })`. A test that wants no pause names `AutoApproveChannel.for(Target)` / `AutoRejectChannel.for(Target)` from `@agboss/core/testing`. Migration: replace `@Tool({ channel: TerminalUserChannel })` with `@Tool({ approval: OwnerApproval })` and declare `@ToolApproval({ name, description, respondent: PauseRespondent.Owner, timeout })`.
