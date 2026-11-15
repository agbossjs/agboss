---
section: Fixed
issue: 1099
---

**`app.extendPause` that loses the store's compare-and-set 8 times in a row now throws a typed
`PauseExtensionContendedError`** (`pause.extension-contended`, `attempts`; #1099) instead of a plain
`Error`. The call changed nothing, so retrying is safe. The cap is the named constant
`MAX_EXTEND_ATTEMPTS`.
