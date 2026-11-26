---
section: Fixed
issue: 1148
---

**`app.setPauseTimeout` with working time decides at the instant of its write** (#1148, #944 acceptance):
the working calendar may take seconds, and the compare-and-set used the clock read before it, so a
deadline that passed meanwhile was still extended — even while the expiry was being handled. The write
now takes the clock read after the calendar answered; a deadline that has passed is `PauseClosedError`,
as for a plain extension. The start check of a working span now counts the grid's holidays
(`[working-calendar.invalid]` when the grid cannot reach the span within 25 years), and the walk's
stall guard and day limit are pinned by tests.
