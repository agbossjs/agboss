---
section: Added
issue: 1306
---

**A quorum's `deadline` in working time** (#1306, #1281c): `.joinQuorum({ min: 2, deadline: workDays(5),
calendar: CorporateWorkingCalendar })` and `.joinQuorumGroups({ deadline: workHours(4), calendar })` wait
working time of the `@WorkingCalendar` class (a `WorkingWeek` grid or a class of its own — the same
arithmetic and call as a pause's `expiresIn`), across weekends, holidays and time zones. The calendar is
asked once at dispatch, for the execution's tenant; its instant is the launch's `deadlineAt`. A working
`deadline` without `calendar` is `[calendar.required-for-working-duration]`; a calendar class is created by
the workflow's container (no `providers` entry). A calendar that fails is `PauseError.WorkingCalendar`:
nothing is dispatched, the launching step's output stays in the scope, and the join's
`.onError(PauseError.WorkingCalendar, …)` takes it. `QuorumOptions` / `QuorumGroupsOptions` are now unions
(`QuorumDeadline`); the printout and `agboss describe` show `deadline: workDays(5), calendar: …`
(`isDeadlineWorking`, `calendar`).
