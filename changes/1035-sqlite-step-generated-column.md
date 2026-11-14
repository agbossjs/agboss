---
section: Fixed
issue: 1035
---

**SQLite: 0.1.0 can still write to a file 0.1.1 has opened, and a huge step no longer makes a thread
unreadable** (#1035, #1036, follow-ups of #962): the `checkpoints.step` column the first #962 build
added to the file broke the positional `INSERT` of 0.1.0 and every older version ("table checkpoints
has 10 columns but 9 values were supplied"), so a rollback or a second process on the old version
failed every checkpoint write. `step` is now a VIRTUAL generated column read from the metadata's
JSON, with the index on it: SQLite leaves it out of a positional `VALUES`, no row is rewritten, and
the backfill is gone. A file a pre-release build gave a stored `step` column is converted when it
is opened. The column is a double, and the saver reads named columns instead of `*`: a step of 2^53
or more (an integer SQLite stored, which `node:sqlite` refuses to read as a number) is sorted
like any other, `getTuple`, `list` and `latestByStep` of its thread succeed. The 0.1.0 package
itself is the writer in the tests.
