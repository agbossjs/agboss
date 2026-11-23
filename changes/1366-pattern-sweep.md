---
section: Changed
issue: 1366
---

**Every spend, rate-limit and deadline site of the files no mutation shard reaches fails a test when it is sabotaged**
(#1366, acceptance round 7): 245 sabotages across the files of `NON_SHARDED_SRC` — each place that pushes, adds, merges
or returns usage or spend, each token, request or slot that is reserved, released or counted, each `min`, `max`, sort or
comparison that combines two deadlines or two limits — were run against the whole unit project. The 83 that survived
now fail a test of their own (the usage of a custom compaction's and a model boundary's masking, the tokens a streamed
call releases on success and on a failed read, the earlier of a pause's run and quorum deadlines, the provider gate's
slots, calls and tokens, the eval run's spend, the model, router, guardrail and reranker spend records, and the limits on
an A2A message's files, among others); four were found equivalent. A file's reason in `NON_SHARDED_SRC` now names the
tests that fail when its sites are sabotaged, and a reason that names a test must name one that exists.
