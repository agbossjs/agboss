---
section: Added
issue: 944
---

**Deadlines in working time: `workingHours(n)`, calendars** (#944, #910): "approve within 2 hours" can
mean 2 working hours. a target's `timeout` and `remindBefore` and `setPauseTimeout`'s `timeout` take `workingHours(n)` / `workingMinutes(n)`
(`@agboss/core/units`, `WorkingDuration`, `isWorkingDuration`) beside `hours(n)`. A calendar turns "now + N
working time" into a date: a target's `calendar` names it — the built-in weekly grid `WorkingWeek.of({ timeZone,
days, hours, breaks, holidays })` (`Weekday`; pointwise and DST-safe: "2 working hours" are always 2 real
hours, no time counted twice, `"24:00"` ends a local date; time zones through `Intl`, no new dependency) or a
`@WorkingCalendar` class (`WorkingCalendarHandler.addWorkingTime({ from, amount, tenantId, channel })`, in
`providers`, may read the application's own data). The deadline is computed once, when the pause opens and
before the channel is asked, into the stored `expiresAt` / `remindAt` (a re-entry never asks the calendar);
a timeout change computes its new deadline the same way; a calendar changed later does not move open pauses. A
working `remindBefore` before a working `timeout` is `calendar.add(askedAt, timeout − remindBefore)`;
a plain `timeout` with a working `remindBefore` is refused at assembly on the target
(`[pause.remind-before-working-without-working-timeout]`) and by `setPauseTimeout`.
A calendar that throws, times out, answers no `Date` or a date not after `from` fails the step —
`StepError.ExternalTask` / `StepError.Agent` with a `PauseError.WorkingCalendar` (`pause.working-calendar`,
`problem`) as its cause, logged `pause.working-calendar-failed` — and nobody is asked; the run's deadline
stays wall-clock. New rules `[calendar.required-for-working-duration]`, `[working-calendar.invalid]`
(a grid with no working time, a class that is no listed `@WorkingCalendar`); `ComponentKind.WorkingCalendar`; `agboss describe` says `expires in 2 h of working time` (`isExpiresInWorking`,
`isRemindBeforeWorking`).
A deadline or reminder is at most 5 years, plain or working. Two `@WorkingCalendar` classes with one name
are `[working-calendar.duplicate-name]`, a listed calendar's dependencies are checked at start, and
`agboss describe` names the calendar of each target (`calendar`).
A working span a grid cannot reach within 25 years (a sparse grid, a long span) is refused at
start (`[working-calendar.invalid]`) and at run time (`PauseError.WorkingCalendar`), never walked.
