---
section: Changed
issue: 909
---

**Cancel is a hard fence for effects** (#909): a cancel request is written to the store first (`ExecutionLeaseRepository.requestCancel(tree)`, a new abstract method every lease store implements), and once it is durable no fenced effect starts or commits and no outbound call is recorded, intended or sent for that tree, compensations included: the write throws `ExecutionCancelFencedError` (code `execution.cancelled.fenced`, an `ExecutionCancelledError`). A send already claimed may still be answered and recorded. A local `app.cancel` resolves only once the mark is durable and may reject on a store error. Migration: a custom `ExecutionLeaseRepository` adds `requestCancel`, and a custom fenced-effect or outbound-call store checks the mark with `cancelTreeOf(key)` (both from `@agboss/core/stores`); the conformance suites carry the cases.
