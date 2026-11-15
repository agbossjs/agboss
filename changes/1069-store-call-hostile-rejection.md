---
section: Fixed
issue: 1069
---

**A store call that rejects with a value that cannot be read as text settles** (#1069): a store that
rejected with an object whose `toString` throws left the bounded call waiting for ever (and an
unhandled rejection behind it), and the same value from the close of a given-up iterator was an
unhandled rejection. The call now ends with an `Error` that carries the value as its `cause`. The
store-call bound and the unknown-outcome handover are in their own mutation shard (`store-bound`). No
migration.
