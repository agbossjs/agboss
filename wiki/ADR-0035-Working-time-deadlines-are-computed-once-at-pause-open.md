# ADR-0035: Working-time deadlines are computed once, when the pause opens

Status: accepted (#944). Builds on [ADR-0033](ADR-0033-A-pause-has-a-deadline) (a pause has a deadline).

## Context

"Approve within 2 hours" means 2 *working* hours for a business: a request at 17:30 on a Thursday in Tel
Aviv is due on Sunday 10:30. The pause's deadline (`expiresAt`, #941) and its reminder (`remindAt`, #942)
are absolute instants that every instance's expiry look, reminder look and answer compare-and-set read from
the stored record. Working time depends on a calendar — days, hours, breaks, holidays, a time zone with DST
— that a project changes, and a holiday table may be the application's own data.

## Decision

1. **Working time is a duration kind, not a deadline kind.** `workingHours(n)` / `workingMinutes(n)`
   (`WorkingDuration`) are accepted wherever `expiresIn` and `remindBefore` are; a calendar turns "now + N
   working time" into a date (`WorkingCalendarHandler.addWorkingTime`). The built-in `WorkingWeek.of(…)` is a
   weekly grid; a `@WorkingCalendar` class sees the tenant and the role and may read application data.
2. **Computed once, stored absolute.** The deadline is computed when the record is made — before the channel
   is asked — and stored in `expiresAt` / `remindAt`; a re-entry finds the record first
   (`findByTenantIdAndRootExecutionIdAndStepKey`) and never asks the calendar again; `findOrCreateByStepKey`
   still decides a race. An extension computes its new deadline the same way. A calendar changed later never
   moves an open pause (extend it instead). No store, no look and no instance ever evaluates a calendar after
   the pause is open: every instance agrees on the deadline whatever its clock or calendar version.
3. **The grid's rule is pointwise.** An instant is working time when its local wall-clock time lies in
   `hours \ breaks` on a working, non-holiday local date; working time between two instants is the real
   elapsed time of the working instants. DST follows without special cases: a gap has no instants, an overlap
   counts both occurrences, `"24:00"` is the end of the local date. Time zones through `Intl`
   (`hourCycle: "h23"`), no dependency.
4. **A calendar that cannot answer fails closed.** The step fails (`QuestionFailedError` / `AgentFailedError`,
   cause `PauseError.WorkingCalendar`), nobody is asked, no record is made. A silent fallback to wall-clock time was
   rejected: it is a deadline nobody asked for.
5. **A reminder cannot be subtracted by a calendar.** A working `remindBefore` needs a working `expiresIn`
   (`calendar.add(askedAt, expiresIn − remindBefore)`); a plain deadline with a working reminder is refused at
   assembly on the role and on every override site, and at run time by `extendPause`.
6. **The run's deadline stays wall-clock.** The smaller of the working deadline and the run's wins, a tie goes
   to the run (#941 D8).

## Consequences

- No new store contract and no change to the timers: the working-time engine runs only in the asking step and
  in `app.extendPause`.
- A holiday added after a pause opened does not shorten it; operators extend or accept.
- A custom calendar's failure is the step's failure, visible and retried by the step's re-entry.
