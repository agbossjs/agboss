---
section: Fixed
issue: 1126
---

**A fault hold after the store answered waits for a claim that found something** (#1126): scenario
22f's hold on `childQueue.claim` was consumed by the empty claim a store with a watch (PostgreSQL's
`LISTEN`) makes at start-up, so the claim that found the child was not held. The same for the pause
notice claim's hold (scenario 21). Test support only.
