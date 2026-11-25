---
section: Changed
issue: 1295
---

**A tool call is checked before anyone is asked about it** (#1295c): the call's arguments are checked
against the tool's input, then searched by the PII policies, then given to the tool interceptors'
`beforeAnyTool` and `@BeforeTool` hooks — all of it before the `@ToolApproval` pause, before
`onToolStart` and before the stream's `ToolCall` event. A call that does not pass (invalid input, a PII
block rule, a hook's `reply` or `block`, a hook that fails, a rewrite that is no input of the tool or holds
a blocked value) never pauses and never runs its tool. The approver sees the arguments as the hooks left
them, masked by the PII policies; an `allow({ input })` rewrite is what is approved and what runs. What was
decided is kept by call id in the loop's new `prepared` channel, so a resume or a restart at the approval
reuses it: no hook is run again and nothing is masked again. An approver's `overrideArguments` are
arguments nobody checked: they go through the same checks once more after the decision. The spend and the
step counts are unchanged; a call with invalid arguments no longer meets `beforeAnyTool`.
