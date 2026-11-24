---
section: Breaking
issue: 1325
---

**Diagnostics and backtraces** (#1325, part c) — `agboss check` draws a broken assembly rule as `rustc`
does: the flow step (`.toAgent(X)`) or the decorator where the node is written, in the user's own source,
under `^^^` (the node the rule is broken at) and `---` (the others it names), with a `= note:` and a
`= help:` from the skills' catalog. `agboss explain <code>` (and `--list`, `--json`) prints what any
assembly rule, check code or error code means and how to fix it, with the class that throws it.

Every `AGBossError` is a `DiagnosedError` that reports itself: `error.format(options?)` and
`console.log(error)` print the chain of causes (`error.chain()`), `Location:`, a logical `Span trace:` (the
step and workflow runs around the error, kept across `await`) and a Rust-style `Stack backtrace:` per
`AGBOSS_BACKTRACE=0|1|full` (`RUST_BACKTRACE` when unset; `0` under `NODE_ENV=production`, `1` elsewhere,
`full` with `--debug`). A report never prints `details`, a field of an error, a foreign cause's message,
the values of an execution, a tenant or any stored or model text. A thrower may add `help`, `notes`,
`suggestionPatch`, `location` and `secondarySpans`, which a family variant's constructor takes too.

- **Removed:** the `chain` property and option of `MeshLoopDetectedError` and `HopsLimitExceededError` —
  `error.chain()` is now the method of every error; the call chain is `callChain`.
- **Added:** `DiagnosedError`, `BacktraceMode`, `ErrorFormatOptions`, `ErrorDiagnostics`,
  `DiagnosedErrorOptions`, `SourceSpan`, `LabeledSpan`, `ExecutionSpanFrame`; on `AGBossError`:
  `location`, `secondarySpans`, `spanTrace`, `notes`, `help`, `suggestionPatch`, `chain()`, `format()`;
  the command `agboss explain`.
- **Changed:** `agboss check` prints a snippet instead of the one line `file code message` for a rule whose
  place in the source is known (`--json` keeps `{ file, code, message }`); `--debug` prints the full report.
