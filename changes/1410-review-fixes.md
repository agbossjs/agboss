---
section: Fixed
issue: 1410
---

**Review fixes of the 0.1.1 bug-hunt integration** (#1410): the audit rows of a swept idle thread are no
longer left behind for good when the process crashes or the audit store fails between the thread's
removal and its rows' (a tree with no record whose rows are all older than the retention and a day is
treated as swept); a failed join that cannot start its side path writes the spend of the held entries
it undid to the ledger; `agboss` releases stdin after any command other than `run` and `chat` even when
the command throws. An MCP call's execution id and idempotency key follow the caller's stable identity
(tenant, owner, peer, tool, `callId`) instead of the MCP session, so a retry with the same `callId` in a
new session (idle timeout, restart, failover) is the same call (an anonymous caller, no tenant, owner or peer, is no one principal: its key stays
per session); the dedupe slot of a trusted MCP call
now includes the owner; a mesh limit's `executionId` on the wire is read up to 200 characters of any
key text (as an `IdGenerator` makes it), so a real loop or hop limit arrives as its typed error. No migration.
