---
section: Breaking
issue: 1325
---

**Six store errors are variants of `StoreError`** (#1325b): `StoreOutcomeUnknownError` is `StoreError.OutcomeUnknown` (`store`, `operation`, `source`), `StoreCallTimeoutError` is `StoreError.CallTimeout` (the same facts and `timeout`; it is a variant of its own now, no longer a subclass of the first — `isStoreOutcomeUnknown(error)` is true for both), `StoredNamesUnreadableError` is `StoreError.UnreadableRecord` (`record`, `ids`, `fields`; `store.unreadable-record`, was `stored.unreadable`), and `CostLedgerEntryInvalidError`, `CostLedgerCutoffInvalidError` and `CostLedgerEntryExpiredError` are `StoreError.LedgerEntryInvalid` (`index`, `reason`), `StoreError.LedgerCutoffInvalid` (`reason`) and `StoreError.LedgerEntryExpired` (`ledgerIds`, `prunedBefore`) with the codes `store.ledger-entry-invalid`, `store.ledger-cutoff-invalid` and `store.ledger-entry-expired` (were `cost-ledger.*`). The classes and their `…Options` types are removed; a store of your own builds them with `new StoreError.CallTimeout({ … })` or `StoreError.of(StoreErrorKind.CallTimeout, { … })`. The sentences are as they were.
