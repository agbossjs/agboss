---
section: Fixed
issue: 1410
---

**Review fixes of the 0.1.1 bug-hunt integration** (#1410): the audit rows of a swept idle thread are no
longer left behind for good when the process crashes or the audit store fails between the thread's
removal and its rows' (a tree with no record whose rows are all older than the retention and a day is
treated as swept); a failed join that cannot start its side path writes the spend of the held entries
it undid to the ledger; `agboss` releases stdin after any command other than `run` and `chat` even when
the command throws. No migration.
