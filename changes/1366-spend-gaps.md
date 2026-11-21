---
section: Changed
issue: 1366
---

**Every place that records, forwards or drops spend is mutated at 100 %, and tested** (#1366, acceptance S of
the ledger and budget groups): the spend a tool call's arguments guardrail and result closing carry (`guardedCall`,
`endedTaskOf`), the masking spend of a failed model call (`observedCall`), the spend of a router whose decision names
no route of its own (`exitOf`, now in `visit-write.ts`), and — found by auditing every file mutated by ranges — the
router's visit, a visit's records and services, a lost pass's records, the cost a child's record reports, a turn's
cost, a paused loop's spend, the approvals', input guardrails' and judges' spend, a branch's state, a mesh report's
charge and its ledger identity, and a policy set's detector spend. Four sabotages that no test caught now fail one.
`PARTLY_SHARDED_SRC` names every file mutated in part, with what it leaves out. The `stopBy` second-call guard of the
instance's stop is killed by its test, not hidden by a crash of the shard. No behaviour changes.
