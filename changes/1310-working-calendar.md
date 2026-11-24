---
section: Breaking
issue: 1310
---

**Working calendars: working days, schedules per assignee, pools** (#1310). `workDays(n)` now counts working days of the calendar's resolved schedule (a local date with working time; weekends and holidays skipped; a start in the middle of a shift counts the rest of that day in proportion), not 24 working hours. `WorkingDuration` is `{ unit: "ms" | "days", amount }` (a frozen value; `workHours` and `workMin` are `"ms"`, `workDays` is `"days"`), and `amountOf` returns the amount in the span's own unit; add `unitOf`.

- Added: `WorkingWeek.anyOf(schedules)` (a pool in several zones: working hours counted over the union of the schedules, working days the earliest of each schedule's own count), `isHoliday(localDate)` beside `holidays` on `WorkingWeek.of`, `@WorkingCalendar({ week })` on an empty class (a declared grid), a `resolveSchedule(ctx)` method on `@WorkingCalendar` classes (the core does the DST and interval arithmetic over the schedule it returns), `@WorkingCalendar({ timeout })` (default `sec(30)`, no longer the tool timeout), `WorkingCalendarContext`, `WorkingScheduleResolver`, `DeclarativeWorkingCalendarOptions`, `DynamicWorkingCalendarOptions`, `WorkingCalendarProblem.InvalidSchedule` and `.MixedUnits`, `unitOf`, `MAX_SPAN_DAYS`.
- Reminders of a working deadline are walked backwards from the (clamped) deadline along the resolved schedule on every `WorkingWeek`-backed calendar, and the units of the deadline and the reminder need not match; a calendar of the project's own that only adds places it forward in one unit (`mixed-units` otherwise).
- A calendar that finds no working time in a year (an `isHoliday` that is always `true`) fails with `RangeError`; the idle limit is 366 days at least.
- Removed: `WorkingTimeRequest` (now `WorkingCalendarContext`: `channel` is `target`, plus `assignees`, and `amount` is a `WorkingDuration`, not milliseconds), `ClockInterval` (now `TimeWindow`), the `Milliseconds` `amount` of `weekReaches`.
