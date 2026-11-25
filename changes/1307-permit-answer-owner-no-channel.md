---
section: Breaking
issue: 1307
---

**`permitAnswer` is enforced, and an owner's pause needs no channel** (#1307c). `app.resume` calls the target's `permitAnswer` (the answerer, the pause's input, the tool call and the decision) after the answer is read and validated and before it is recorded or the tree moves; only `true` lets it through — `false`, a throw, a rejection and any other value refuse the resume with `PauseAnswererError`, and the pause stays pending. A resume after the deadline or a second answer is still refused first, so the hook is never asked for a closed pause. `[pause.permit-hook-not-enforced]` now names only `permitTimeoutChange` and `permitReassign`. A `@ToolApproval` or `@ExternalTask` with `respondent: PauseRespondent.Owner` and no `@Channel({ target })` is valid: nobody is asked, the pause is recorded as sent and waits for the owner's `app.resume` (`[channel.missing-for-target]` still applies to a delegate's target).
