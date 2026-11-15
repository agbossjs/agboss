---
section: Fixed
issue: 1115
---

**`latestByStep` tie order, stated: equal steps go to the greatest `checkpoint_id` by code point (UTF-8 byte order), not by UTF-16 code unit, on every path**
(#1115): the contract said code unit (JavaScript's `<`), while SQLite's index, PostgreSQL's
`COLLATE "C"` and MongoDB's string order compare bytes, which is code point order, so one saver
answered differently per path when an id held a character above U+FFFF. The contract is now code point
order; the scan, the in-memory saver and the serde read of the SQLite saver compare by code point
(`compareCodePoints`), and the conformance cases cover `"\u{10000}"` against `"￿"`, so the
PostgreSQL and MongoDB savers inherit the check. LangGraph's own ids are ASCII, so nothing changes for them.
