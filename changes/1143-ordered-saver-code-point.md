---
section: Fixed
issue: 1143
---

**The checkpointer compares checkpoint ids by code point, as the stores order them** (#1143): a new id in U+E000..U+FFFF written after an id above U+FFFF was compared by UTF-16 code unit, so the thread was not marked out of order and `getTuple` kept returning the older checkpoint. `OrderedCheckpointSaver` now uses the code-point order of #1115, and the in-memory saver's `getTuple` and `list` order ids the same way. LangGraph's own uuid ids are unaffected. No migration.
