---
section: Changed
issue: 1356
---

**A cold mutation shard may run for four hours** (#1356): six shards (`pauses`, `spend`, `takeover`, `cancel`, `sqlite-stores`, `files-pii`) were cancelled at the 90-minute job limit of `mutation-shards.yml` on a cold run of all 45 shards beside other jobs; the limit is now 240 minutes (the GitHub limit is 360), so a cold run scores them instead of cutting them off.
