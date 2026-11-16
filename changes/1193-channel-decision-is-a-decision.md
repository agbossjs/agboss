---
section: Fixed
issue: 1193
---

**A channel's decision for a reassigned send is a decision, not a person's reply** (#1193): the
pause answer log said `replied` and `pauses.time_to_answer` timed the channel's own answer as a
human wait, and `pauses.closed` counted a replacement that `pauses.opened` never counted. It is now
logged `decided`, like the first send's decided-at-once outcome, and neither timed nor counted
closed; a person's answer of a replacement is counted as before. No migration.
