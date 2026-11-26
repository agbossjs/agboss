---
section: Added
issue: 944
---

**Deadlines in working time: `workingHours(n)`, calendars** (#944, #910): "approve within 2 hours" can
mean 2 working hours. `expiresIn`, `remindBefore` (`@ChannelRole`, `.toQuestion(Role, { expiresIn })`,
`@Tool({ expiresIn })`) and `setPauseTimeout`'s `expiresIn` take `workingHours(n)` / `workingMinutes(n)`
(`@agboss/core/units`, `WorkingDuration`, `isWorkingDuration`) beside `hours(n)`. A calendar turns "now + N
working time" into a date: `@Application({ workingCalendar })` is the default, a role's
`@ChannelRole({ workingCalendar })` overrides it — the built-in weekly grid `WorkingWeek.of({ timeZone,
days, hours, breaks, holidays })` (`Weekday`; pointwise and DST-safe: "2 working hours" are always 2 real
hours, no time counted twice, `"24:00"` ends a local date; time zones through `Intl`, no new dependency) or a
`@WorkingCalendar` class (`WorkingCalendarHandler.addWorkingTime({ from, amount, tenantId, channel })`, in
`providers`, may read the application's own data). The deadline is computed once, when the pause opens and
before the channel is asked, into the stored `expiresAt` / `remindAt` (a re-entry never asks the calendar);
an extension computes its new deadline the same way; a calendar changed later does not move open pauses. A
working `remindBefore` before a working `expiresIn` is `calendar.add(askedAt, expiresIn − remindBefore)`;
a plain `expiresIn` with a working `remindBefore` is refused at assembly on the role and on every override
site (`[channel.remind-before-working-without-working-expiry]`) and by `setPauseTimeout` (`DtoValidationError`).
A calendar that throws, times out, answers no `Date` or a date not after `from` fails the step —
`QuestionFailedError` / `AgentFailedError` with a `WorkingCalendarError` (`pause.working-calendar`,
`problem`) as its cause, logged `pause.working-calendar-failed` — and nobody is asked; the run's deadline
stays wall-clock. New rules `[channel.working-time-without-calendar]`, `[working-calendar.invalid]`
(a grid with no working time, a class that is no listed `@WorkingCalendar`); `NameKind.WorkingCalendar`
(`-working-calendar`); `agboss describe` says `expires in 2 h of working time` (`isExpiresInWorking`,
`isRemindBeforeWorking`).
A deadline or reminder is at most 5 years, plain or working. Two `@WorkingCalendar` classes with one name
are `[working-calendar.duplicate-name]`, a listed calendar's dependencies are checked at start, and
`agboss describe` names the calendar behind the application and each role (`workingCalendar`).
A working span a grid cannot reach within 25 years (a sparse grid, a long span) is refused at
start (`[working-calendar.invalid]`) and at run time (`WorkingCalendarError`), never walked.
